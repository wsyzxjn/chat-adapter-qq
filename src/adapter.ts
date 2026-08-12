import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ChatError, ConsoleLogger, Message, NotImplementedError, RateLimitError } from "chat";
import {
  APP_ID_HEADER,
  CALLBACK_ACK_OPCODE,
  CALLBACK_DISPATCH_OPCODE,
  CALLBACK_VALIDATION_OPCODE,
  DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_INBOUND_DEDUPE_MAX_ENTRIES,
  DEFAULT_INBOUND_DEDUPE_TTL_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  FEATURE_SUPPORT,
  MAX_CACHE_MESSAGES_PER_THREAD,
  SIGNATURE_HEADER,
  SIGNATURE_TIMESTAMP_HEADER,
  isQQActionEventType,
  isQQMessageEventType,
  isQQPlatformEventType,
  type QQFeature,
} from "./constants";
import { QQFormatConverter } from "./format-converter.js";
import { QQGatewayClient } from "./gateway.js";
import type {
  QQAccessTokenResponse,
  QQAdapterConfig,
  QQActionEventDataMap,
  QQArkPayload,
  QQGatewayBotResponse,
  QQIncomingMessage,
  QQInputNotifyPayload,
  QQInteractionPayload,
  QQMessageEventType,
  QQMessageEventDataMap,
  QQMediaPayload,
  QQMediaUploadRequest,
  QQMediaUploadResponse,
  QQPlatformEvent,
  QQPlatformEventDataMap,
  QQPlatformEventHandler,
  QQPlatformEventType,
  QQQuotedMessage,
  QQRawMessage,
  QQSendMessageRequest,
  QQSendMessageOptions,
  QQSentMessage,
  QQSocketModeOptions,
  QQStreamMessageRequest,
  QQStreamMessageResponse,
  QQThreadResolvableEventData,
  QQThreadType,
  QQThreadId,
  QQC2CThreadId,
  QQWebhookPayload,
} from "./types.js";
import {
  buildMessageContentPayload,
  getDeleteMessagePath,
  getPostableAttachments,
  getPostMessagePath,
  getUploadMediaPath,
  hasSendCaption,
  resolveQQMediaFileType,
  streamChunkToText,
  toAttachments,
  validateMessagePayload,
} from "./utils/message-payload.js";
import {
  decodeThreadId as decodeQQThreadId,
  encodeThreadId as encodeQQThreadId,
  fromThreadStorage,
  getChannelName,
  toThreadMetadata,
  toThreadStorageId,
} from "./utils/thread-id.js";
import {
  assertNever,
  buildInboundMessageDedupeKey,
  bytesToArrayBuffer,
  bytesToBase64,
  bytesToHex,
  concatBytes,
  createBotSeed,
  findMessageSceneValue,
  hexToBytes,
  isValidationPayload,
  parseCursor,
  parseQQTimestamp,
  resolveInboundDisplayText,
  resolveQQEndpoints,
  sha256Hex,
  stringToBytes,
  toChatError,
  TtlSeenSet,
  uploadLocalFileChunked,
} from "./utils/index.js";

interface AccessTokenCache {
  expiresAt: number;
  token: string;
}

interface MediaCacheEntry {
  expiresAt: number | null;
  media: QQMediaPayload;
}

interface PassiveContext {
  eventId?: string;
  msgId?: string;
  nextMsgSeq: number;
}

interface SigningKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

interface ParsedMessageEvent {
  raw: QQRawMessage;
  threadId: string;
}

interface ParsedActionEvent {
  actionId: string;
  messageId: string;
  raw: QQInteractionPayload;
  threadId: string;
  triggerId: string;
  user: Author;
  value?: string;
}

interface SignatureCheckResult {
  ok: boolean;
  reason?: string;
}

interface ApiRequestResult<T> {
  body: T;
  status: number;
}

type DispatchProcessResult = "handled" | "ignored" | "not_initialized" | "unsupported";

const ED25519_PRIVATE_KEY_DER_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);
const QQ_SIGNATURE_SIZE = 64;

/**
 * Chat SDK adapter for QQ Bot OpenAPI v2 (webhook mode).
 *
 * Supported scenes:
 * - C2C
 * - Group
 *
 * Guild channel support is modeled in thread IDs but remains unimplemented for
 * outbound APIs in this adapter.
 */
export class QQAdapter implements Adapter<QQThreadId, QQRawMessage> {
  readonly name = "qq";
  readonly persistThreadHistory = true;
  readonly userName: string;

  private chat: ChatInstance | null = null;
  private apiBaseUrl: string;
  private tokenEndpoint: string;
  private fallbackApiBaseUrl: string | undefined;
  private fallbackTokenEndpoint: string | undefined;
  private readonly config: QQAdapterConfig;
  private readonly converter = new QQFormatConverter();
  private readonly inboundDedupe: TtlSeenSet;
  private readonly logger: Logger;
  private readonly mediaCache = new Map<string, MediaCacheEntry>();
  private readonly platformEventHandlers = new Map<QQPlatformEventType, Set<QQPlatformEventHandler>>();
  private readonly platformEventCatchAllHandlers = new Set<QQPlatformEventHandler>();
  private readonly messageCache = new Map<string, Message<QQRawMessage>[]>();
  private readonly passiveContextByThread = new Map<string, PassiveContext>();
  private accessTokenCache: AccessTokenCache | null = null;
  private gatewayClients: QQGatewayClient[] = [];
  private signingKeysCache: SigningKeys | null = null;

  constructor(config: QQAdapterConfig) {
    if (!config.appId) {
      throw new Error("QQ adapter requires `appId`.");
    }
    if (!config.clientSecret) {
      throw new Error("QQ adapter requires `clientSecret`.");
    }

    this.config = config;
    this.userName = config.userName ?? "qq-bot";
    this.logger = config.logger ?? new ConsoleLogger();
    const endpoints = resolveQQEndpoints(config);
    this.apiBaseUrl = endpoints.apiBaseUrl;
    this.tokenEndpoint = endpoints.tokenEndpoint;
    this.fallbackApiBaseUrl = endpoints.fallbackApiBaseUrl;
    this.fallbackTokenEndpoint = endpoints.fallbackTokenEndpoint;
    this.inboundDedupe = new TtlSeenSet(
      config.inboundDedupeTtlMs ?? DEFAULT_INBOUND_DEDUPE_TTL_MS,
      config.inboundDedupeMaxEntries ?? DEFAULT_INBOUND_DEDUPE_MAX_ENTRIES,
    );
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    if (this.config.mode === "socket") {
      await this.startSocketMode();
    }
  }

  async disconnect(): Promise<void> {
    await this.stopSocketMode();
  }

  async startSocketMode(options?: QQSocketModeOptions): Promise<void> {
    if (this.gatewayClients.some((client) => client.isActive)) {
      this.logger.debug("QQ gateway already started");
      return;
    }

    const socketOptions: QQSocketModeOptions = {
      ...this.config.socketMode,
      ...options,
    };
    const needsGatewayInfo = !socketOptions.url
      || (!socketOptions.shard && socketOptions.autoSharding !== false);
    const gatewayInfo = needsGatewayInfo
      ? await this.fetchGatewayBot()
      : { url: socketOptions.url! };
    const url = socketOptions.url ?? gatewayInfo.url;
    const recommendedShards = socketOptions.autoSharding === false
      ? 1
      : Math.max(1, Math.trunc(gatewayInfo.shards ?? 1));
    const shards: Array<readonly [number, number]> = socketOptions.shard
      ? [socketOptions.shard]
      : Array.from({ length: recommendedShards }, (_, index) => [index, recommendedShards] as const);
    const startLimit = gatewayInfo.session_start_limit;

    if (startLimit && startLimit.remaining < shards.length) {
      throw new RateLimitError(
        `QQ gateway requires ${shards.length} sessions but only ${startLimit.remaining} starts remain.`,
        startLimit.reset_after,
      );
    }

    const clients = shards.map((shard) => new QQGatewayClient({
      getGatewayInfo: async () => ({ ...gatewayInfo, url }),
      getToken: () => this.getAccessToken(),
      logger: this.logger,
      onDispatch: (payload) => this.handleSocketModePayload(payload),
      options: {
        ...socketOptions,
        shard,
        url,
      },
    }));
    this.gatewayClients = clients;

    const maxConcurrency = Math.max(1, Math.trunc(startLimit?.max_concurrency ?? clients.length));
    try {
      for (let index = 0; index < clients.length; index += maxConcurrency) {
        const batch = clients.slice(index, index + maxConcurrency);
        await Promise.all(batch.map((client) => client.start()));
        if (index + maxConcurrency < clients.length) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    } catch (error) {
      await Promise.all(clients.map((client) => client.stop()));
      this.gatewayClients = [];
      throw error;
    }
  }

  async stopSocketMode(): Promise<void> {
    const clients = this.gatewayClients;
    this.gatewayClients = [];
    await Promise.all(clients.map((client) => client.stop()));
  }

  async handleSocketModePayload(payload: QQWebhookPayload<unknown>, options?: WebhookOptions): Promise<void> {
    if (payload.op !== CALLBACK_DISPATCH_OPCODE) {
      this.logger.debug("Ignoring non-dispatch QQ gateway payload", {
        op: payload.op,
        s: payload.s,
        t: payload.t,
      });
      return;
    }

    await this.processDispatchPayload(payload, options, "socket");
  }

  onEvent(handler: QQPlatformEventHandler): () => void;
  onEvent<TType extends QQPlatformEventType>(
    type: TType,
    handler: QQPlatformEventHandler<TType>,
  ): () => void;
  onEvent<TType extends QQPlatformEventType>(
    types: readonly TType[],
    handler: QQPlatformEventHandler<TType>,
  ): () => void;
  onEvent<TType extends QQPlatformEventType>(
    typeOrHandler: TType | readonly TType[] | QQPlatformEventHandler,
    handler?: QQPlatformEventHandler<TType>,
  ): () => void {
    if (typeof typeOrHandler === "function") {
      this.platformEventCatchAllHandlers.add(typeOrHandler);
      return () => {
        this.platformEventCatchAllHandlers.delete(typeOrHandler);
      };
    }

    if (!handler) {
      throw new Error("QQ adapter onEvent requires a handler.");
    }

    const types = Array.isArray(typeOrHandler) ? typeOrHandler : [typeOrHandler];
    for (const type of types) {
      let handlers = this.platformEventHandlers.get(type);
      if (!handlers) {
        handlers = new Set();
        this.platformEventHandlers.set(type, handlers);
      }
      handlers.add(handler as QQPlatformEventHandler);
    }

    return () => {
      for (const type of types) {
        const handlers = this.platformEventHandlers.get(type);
        handlers?.delete(handler as QQPlatformEventHandler);
        if (handlers?.size === 0) {
          this.platformEventHandlers.delete(type);
        }
      }
    };
  }

  offEvent<TType extends QQPlatformEventType>(
    type: TType,
    handler: QQPlatformEventHandler<TType>,
  ): void;
  offEvent<TType extends QQPlatformEventType>(
    types: readonly TType[],
    handler: QQPlatformEventHandler<TType>,
  ): void;
  offEvent<TType extends QQPlatformEventType>(
    typeOrTypes: TType | readonly TType[],
    handler: QQPlatformEventHandler<TType>,
  ): void {
    const types = Array.isArray(typeOrTypes) ? typeOrTypes : [typeOrTypes];
    for (const type of types) {
      const handlers = this.platformEventHandlers.get(type);
      handlers?.delete(handler as QQPlatformEventHandler);
      if (handlers?.size === 0) {
        this.platformEventHandlers.delete(type);
      }
    }
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  /** Encode structured QQ thread object to stable adapter thread id string. */
  encodeThreadId(thread: QQThreadId): string {
    return encodeQQThreadId(this.name, thread);
  }

  /** Decode adapter thread id string into structured QQ scene identifiers. */
  decodeThreadId(threadId: string): QQThreadId {
    return decodeQQThreadId(this.name, threadId);
  }

  isDM(threadId: string): boolean {
    return this.decodeThreadId(threadId).type === "c2c";
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ type: "c2c", userOpenId: userId });
  }

  /**
   * Handle QQ webhook callback:
   * - validation challenge response
   * - signature/appId checks for dispatch events
   * - message event extraction and Chat SDK dispatch
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return this.createWebhookErrorResponse(405, "METHOD_NOT_ALLOWED", "Only POST webhooks are supported.");
      }

      const rawBody = await request.text();
      let payload: QQWebhookPayload<unknown>;
      try {
        payload = JSON.parse(rawBody) as QQWebhookPayload<unknown>;
      } catch (error) {
        this.logger.warn("Failed to parse QQ webhook body", error);
        return this.createWebhookErrorResponse(400, "INVALID_JSON", "Webhook body is not valid JSON.");
      }
      this.logger.debug("QQ webhook payload parsed", {
        hasEventTs: typeof (payload.d as { event_ts?: unknown } | undefined)?.event_ts === "string",
        hasPlainToken: typeof (payload.d as { plain_token?: unknown } | undefined)?.plain_token === "string",
        op: payload.op,
        s: payload.s,
        t: payload.t,
      });

      const headerAppId = request.headers.get(APP_ID_HEADER);
      if ((this.config.requireAppIdHeader ?? true) && !headerAppId) {
        this.logger.warn("QQ webhook missing appId header", {
          requiredHeader: APP_ID_HEADER,
        });
        return this.createWebhookErrorResponse(
          401,
          "MISSING_APP_ID_HEADER",
          `Missing required header: ${APP_ID_HEADER}.`,
        );
      }
      if (headerAppId && headerAppId !== this.config.appId) {
        this.logger.warn("QQ webhook appId mismatch", {
          expected: this.config.appId,
          received: headerAppId,
        });
        return this.createWebhookErrorResponse(401, "APP_ID_MISMATCH", "Webhook appId does not match adapter appId.");
      }

      if (payload.op === CALLBACK_VALIDATION_OPCODE) {
        this.logger.debug("QQ webhook validation challenge received");
        return this.handleValidationChallenge(payload);
      }

      if (this.config.verifySignature !== false) {
        const signatureCheck = await this.verifyWebhookSignature(request.headers, rawBody);
        if (!signatureCheck.ok) {
          this.logger.warn("QQ webhook signature validation failed", {
            reason: signatureCheck.reason,
          });
          return this.createWebhookErrorResponse(401, "INVALID_SIGNATURE", signatureCheck.reason ?? "Invalid signature.");
        }
      }

      if (payload.op !== CALLBACK_DISPATCH_OPCODE) {
        return this.createCallbackAckResponse(payload.s);
      }

      const result = await this.processDispatchPayload(payload, options, "webhook");
      if (result === "not_initialized") {
        return this.createWebhookErrorResponse(500, "ADAPTER_NOT_INITIALIZED", "Adapter is not initialized.");
      }
      if (result === "unsupported" && this.config.strictWebhookEvents) {
        return this.createWebhookErrorResponse(400, "UNSUPPORTED_EVENT", "Unsupported webhook dispatch event.", {
          eventId: this.resolvePayloadEventId(payload),
          type: payload.t ?? "unknown",
        });
      }
      return this.createCallbackAckResponse(payload.s);
    } catch (error) {
      this.logger.error("QQ webhook handling failed", error);
      return this.createWebhookErrorResponse(500, "WEBHOOK_INTERNAL_ERROR", "Internal webhook handler error.");
    }
  }

  parseMessage(raw: QQRawMessage): Message<QQRawMessage> {
    const thread = this.resolveThreadFromRaw(raw);
    const threadId = this.encodeThreadId(thread);
    const content = resolveInboundDisplayText(raw) || raw.content || "";
    const authorId = this.resolveAuthorId(raw);
    const isMe = raw._chat_is_outbound === true;
    const dateSent = parseQQTimestamp(raw.timestamp, true);
    const editedAt = parseQQTimestamp(raw.edited_timestamp, false);
    const metadata = {
      dateSent,
      edited: Boolean(editedAt),
      ...(editedAt ? { editedAt } : {}),
    };

    return new Message({
      attachments: toAttachments(raw.attachments),
      author: {
        fullName: raw.author?.username ?? raw.author?.nick ?? authorId,
        isBot: raw.author?.bot ?? "unknown",
        isMe,
        userId: authorId,
        userName: raw.author?.username ?? raw.author?.nick ?? authorId,
      },
      formatted: this.converter.toAst(content),
      id: raw.id ?? raw.msg_id ?? crypto.randomUUID(),
      ...(raw._chat_is_mention !== undefined ? { isMention: raw._chat_is_mention } : {}),
      metadata,
      raw,
      text: this.converter.extractPlainText(content),
      threadId,
    });
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<QQRawMessage>> {
    return this.postQQMessage(threadId, message);
  }

  async postQQMessage(
    threadId: string,
    message: AdapterPostableMessage,
    options: QQSendMessageOptions = {},
  ): Promise<RawMessage<QQRawMessage>> {
    validateMessagePayload(message);
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "postMessage");
    if (options.isWakeup && thread.type !== "c2c") {
      throw new ChatError("QQ `isWakeup` is only valid for C2C messages.", "INVALID_REQUEST");
    }
    if (options.isWakeup && options.passiveContext === true) {
      throw new ChatError("QQ `isWakeup` cannot be combined with passive reply context.", "INVALID_REQUEST");
    }

    const payloads = await this.buildSendPayloads(threadId, thread, message, options);
    let sent: RawMessage<QQRawMessage> | null = null;
    for (const payload of payloads) {
      sent = await this.postPayload(threadId, thread, payload);
    }
    if (!sent) {
      throw new ChatError("QQ postMessage produced no outbound payload.", "INVALID_REQUEST");
    }
    return sent;
  }

  async postArk(threadId: string, ark: QQArkPayload): Promise<RawMessage<QQRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "postMessage");
    return this.postPayload(threadId, thread, this.withPassiveContext(threadId, {
      ark,
      msg_type: 3,
    }));
  }

  private async postPayload(
    threadId: string,
    thread: QQThreadId,
    payload: QQSendMessageRequest,
  ): Promise<RawMessage<QQRawMessage>> {
    const path = getPostMessagePath(thread);
    const result = await this.apiRequestWithMeta<QQSentMessage & {
      audit_id?: string;
      code?: number;
      message?: string;
    }>(path, {
      body: JSON.stringify(payload),
      method: "POST",
    });
    const sentRaw = result.body;
    const asynchronouslyAccepted = result.status === 201 || result.status === 202;
    const content = sentRaw.content ?? payload.content ?? payload.markdown?.content;
    const generatedId = asynchronouslyAccepted
      ? `qq:pending/${sentRaw.audit_id ?? crypto.randomUUID()}`
      : crypto.randomUUID();

    const enrichedRaw: QQRawMessage = {
      ...sentRaw,
      ...(asynchronouslyAccepted && sentRaw.code !== undefined
        ? { _chat_async_code: sentRaw.code }
        : {}),
      ...(asynchronouslyAccepted && sentRaw.message
        ? { _chat_async_message: sentRaw.message }
        : {}),
      _chat_delivery_status: asynchronouslyAccepted ? "accepted" : "delivered",
      _chat_http_status: result.status,
      _chat_is_outbound: true,
      _chat_thread_id: toThreadStorageId(thread),
      _chat_thread_type: thread.type,
      author: sentRaw.author ?? this.getOutboundAuthor(thread.type),
      id: sentRaw.id ?? sentRaw.msg_id ?? generatedId,
      timestamp: sentRaw.timestamp ?? new Date().toISOString(),
      ...(content !== undefined ? { content } : {}),
      ...(sentRaw.msg_id !== undefined || payload.msg_id !== undefined
        ? { msg_id: sentRaw.msg_id ?? payload.msg_id }
        : {}),
    };

    const parsed = this.parseMessage(enrichedRaw);
    this.cacheMessage(parsed);
    return {
      id: parsed.id,
      raw: enrichedRaw,
      threadId,
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "deleteMessage");
    const path = getDeleteMessagePath(thread, messageId);
    await this.apiRequest(path, { method: "DELETE" });
  }

  mentionUser(userId: string): string {
    return `<qqbot-at-user id="${userId}" />`;
  }

  async editMessage(threadId: string, _messageId: string, _message: AdapterPostableMessage): Promise<RawMessage<QQRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "editMessage");
    throw new NotImplementedError(
      `QQ API v2 does not provide editMessage for scene: ${thread.type}.`,
      "editMessage",
    );
  }

  async addReaction(threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "addReaction");
    throw new NotImplementedError(`QQ reactions are not implemented for scene: ${thread.type}.`, "addReaction");
  }

  async removeReaction(threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "removeReaction");
    throw new NotImplementedError(`QQ reaction removal is not implemented for scene: ${thread.type}.`, "removeReaction");
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    if (thread.type !== "c2c") {
      this.logger.debug("QQ startTyping: not supported for non-c2c scenes", { threadType: thread.type });
      return;
    }

    const context = this.passiveContextByThread.get(threadId);
    const payload: QQSendMessageRequest = {
      input_notify: {
        input_second: 60,
        input_type: 1,
      },
      msg_type: 6,
      ...(context?.msgId
        ? { msg_id: context.msgId, msg_seq: context.nextMsgSeq }
        : context?.eventId
          ? { event_id: context.eventId }
          : {}),
    };

    // Advance msg_seq if used.
    if (context?.msgId) {
      context.nextMsgSeq += 1;
    }

    try {
      await this.apiRequest(`/v2/users/${encodeURIComponent(thread.userOpenId)}/messages`, {
        body: JSON.stringify(payload),
        method: "POST",
      });
      this.logger.debug("QQ startTyping sent", { threadId, userOpenId: thread.userOpenId });
    } catch (error) {
      this.logger.warn("QQ startTyping failed", { error, threadId });
    }
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<QQRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    this.logger.debug("QQ stream called", { threadId, threadType: thread.type });

    // Group scene: fallback to regular postMessage after collecting all content.
    if (thread.type !== "c2c") {
      this.logger.debug("QQ stream: group scene, using fallback");
      return this.streamAsFallback(threadId, textStream);
    }

    // C2C scene: use QQ native stream_messages API.
    return this.streamC2C(threadId, thread, textStream);
  }

  private async streamAsFallback(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<QQRawMessage>> {
    this.logger.debug("QQ streamAsFallback started");
    let content = "";
    let chunkCount = 0;
    for await (const chunk of textStream) {
      chunkCount++;
      content += streamChunkToText(chunk);
    }
    this.logger.debug("QQ streamAsFallback completed", { chunkCount, contentLength: content.length });
    return this.postMessage(threadId, content || " ");
  }

  private async streamC2C(
    threadId: string,
    thread: QQC2CThreadId,
    textStream: AsyncIterable<string | StreamChunk>,
  ): Promise<RawMessage<QQRawMessage>> {
    this.logger.debug("QQ streamC2C started", { threadId, userOpenId: thread.userOpenId });

    const initialContext = this.passiveContextByThread.get(threadId);
    if (!initialContext?.msgId) {
      this.logger.info("QQ native stream requires passive msg_id context; using fallback", { threadId });
      return this.streamAsFallback(threadId, textStream);
    }

    // Notify QQ client that bot is typing.
    await this.startTyping(threadId);

    const context = this.passiveContextByThread.get(threadId)!;
    const streamMsgSeq = context.nextMsgSeq;
    context.nextMsgSeq += 1;

    const { StreamingMarkdownRenderer } = await import("chat");
    const renderer = new StreamingMarkdownRenderer();

    let streamMsgId: string | undefined;
    let index = 0;
    let stopped = false;
    let pendingSend: Promise<void> | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let lastSentContent = "";
    let chunkCount = 0;

    const UPDATE_INTERVAL_MS = 500;
    this.logger.debug("QQ streamC2C passive context", {
      context: { eventId: context.eventId, msgId: context.msgId, msgSeq: streamMsgSeq },
    });

    const sendChunk = async (content: string, isFinal: boolean): Promise<QQStreamMessageResponse | null> => {
      const payload: QQStreamMessageRequest = {
        input_mode: "replace",
        input_state: isFinal ? 10 : 1,
        content_type: "markdown",
        content_raw: content,
        event_id: context.eventId ?? "",
        index,
        msg_id: context.msgId!,
        msg_seq: streamMsgSeq,
        ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
      };

      this.logger.debug("QQ stream_messages API call", { isFinal, index, contentLength: content.length, contentPreview: content.slice(0, 100) });

      try {
        const response = await this.apiRequest<QQStreamMessageResponse>(
          `/v2/users/${encodeURIComponent(thread.userOpenId)}/stream_messages`,
          {
            body: JSON.stringify(payload),
            method: "POST",
          },
        );
        this.logger.debug("QQ stream_messages API response", { isFinal, index, responseId: response.id, response });
        return response;
      } catch (error) {
        this.logger.warn("QQ stream message API call failed", { isFinal, index, error });
        return null;
      }
    };

    const doSendAndSchedule = async () => {
      if (stopped) {
        this.logger.debug("QQ stream doSendAndSchedule skipped: stopped");
        return;
      }

      const content = renderer.render();
      this.logger.debug("QQ stream doSendAndSchedule", { contentLength: content.length, contentPreview: content.slice(0, 100), lastSentContentLength: lastSentContent.length });

      if (content !== lastSentContent && content.trim()) {
        const response = await sendChunk(content, false);
        if (response?.id) {
          if (!streamMsgId) {
            streamMsgId = response.id;
            this.logger.debug("QQ stream streamMsgId established", { streamMsgId });
          }
          lastSentContent = content;
          index++;
        } else {
          this.logger.debug("QQ stream sendChunk returned no id");
        }
      } else {
        this.logger.debug("QQ stream doSendAndSchedule: content unchanged or empty");
      }

      if (!stopped) {
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      this.logger.debug("QQ stream scheduleNext", { intervalMs: UPDATE_INTERVAL_MS });
      timerId = setTimeout(() => {
        pendingSend = doSendAndSchedule();
      }, UPDATE_INTERVAL_MS);
    };

    scheduleNext();

    try {
      for await (const chunk of textStream) {
        chunkCount++;
        const text = streamChunkToText(chunk);
        this.logger.debug("QQ stream received chunk", { chunkCount, textLength: text.length, textPreview: text.slice(0, 50) });
        renderer.push(text);
      }
    } finally {
      this.logger.debug("QQ stream textStream ended", { chunkCount, stopped });
      stopped = true;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
    }

    this.logger.debug("QQ stream after textStream", { pendingSend: !!pendingSend, streamMsgId });

    if (pendingSend) {
      this.logger.debug("QQ stream awaiting pendingSend");
      await pendingSend;
      this.logger.debug("QQ stream pendingSend completed", { streamMsgId });
    }

    const finalContent = renderer.finish();
    this.logger.debug("QQ stream finalContent", { length: finalContent.length, preview: finalContent.slice(0, 100) });

    // Stream never established: fallback to regular message.
    if (!streamMsgId) {
      this.logger.info("QQ stream never established, falling back to regular message", { chunkCount });
      return this.postMessage(threadId, finalContent || " ");
    }

    // Send final message.
    this.logger.debug("QQ stream sending final message", { streamMsgId, finalIndex: index });
    const finalResponse = await sendChunk(finalContent, true);
    if (!finalResponse?.id) {
      this.logger.warn("QQ stream final message failed, falling back to regular message");
      return this.postMessage(threadId, finalContent || " ");
    }
    this.logger.debug("QQ stream final message sent", { finalResponseId: finalResponse.id });

    const enrichedRaw: QQRawMessage = {
      ...finalResponse,
      _chat_is_outbound: true,
      _chat_thread_id: toThreadStorageId(thread),
      _chat_thread_type: thread.type,
      author: this.getOutboundAuthor(thread.type),
      id: finalResponse.id ?? crypto.randomUUID(),
      timestamp: finalResponse.timestamp ?? new Date().toISOString(),
      content: finalContent,
    };

    const parsed = this.parseMessage(enrichedRaw);
    this.cacheMessage(parsed);

    return {
      id: parsed.id,
      raw: enrichedRaw,
      threadId,
    };
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const decoded = this.decodeThreadId(threadId);
    return {
      channelId: threadId,
      id: threadId,
      isDM: decoded.type === "c2c",
      metadata: toThreadMetadata(decoded),
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const decoded = this.decodeThreadId(channelId);
    return {
      id: channelId,
      isDM: decoded.type === "c2c",
      metadata: toThreadMetadata(decoded),
      name: getChannelName(decoded),
    };
  }

  async fetchChannelMessages(channelId: string, options?: FetchOptions): Promise<FetchResult<QQRawMessage>> {
    return this.fetchMessages(channelId, options);
  }

  async postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<QQRawMessage>> {
    return this.postMessage(channelId, message);
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<QQRawMessage> | null> {
    const cache = this.messageCache.get(threadId) ?? [];
    return cache.find((message) => message.id === messageId) ?? null;
  }

  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<QQRawMessage>> {
    const all = this.messageCache.get(threadId) ?? [];
    const limit = Math.max(1, options?.limit ?? DEFAULT_FETCH_LIMIT);
    const direction = options?.direction ?? "backward";
    const cursorIndex = parseCursor(options?.cursor);

    if (direction === "forward") {
      const start = Math.max(0, cursorIndex ?? 0);
      const end = Math.min(all.length, start + limit);
      return {
        messages: all.slice(start, end),
        ...(end < all.length ? { nextCursor: String(end) } : {}),
      };
    }

    const end = Math.max(0, Math.min(all.length, cursorIndex ?? all.length));
    const start = Math.max(0, end - limit);
    return {
      messages: all.slice(start, end),
      ...(start > 0 ? { nextCursor: String(start) } : {}),
    };
  }

  private async processDispatchPayload(
    payload: QQWebhookPayload<unknown>,
    options: WebhookOptions | undefined,
    source: "socket" | "webhook",
  ): Promise<DispatchProcessResult> {
    const event = this.extractMessageEvent(payload);
    if (event) {
      if (!this.chat) {
        this.logger.error(`QQ adapter received ${source} event before initialize()`);
        return "not_initialized";
      }

      const dedupeKey = buildInboundMessageDedupeKey(event.raw, event.threadId);
      if (dedupeKey && this.inboundDedupe.seen(dedupeKey)) {
        this.logger.debug("Ignoring duplicate QQ inbound message", {
          eventId: this.resolvePayloadEventId(payload),
          key: dedupeKey,
          source,
          type: payload.t,
        });
        return "ignored";
      }

      const message = this.parseMessage(event.raw);
      this.cacheMessage(message);
      this.updatePassiveContext(event.threadId, event.raw);
      if (this.processSlashCommand(event.threadId, message, options)) {
        return "handled";
      }
      this.chat.processMessage(this, event.threadId, message, options);
      return "handled";
    }

    const action = this.extractActionEvent(payload);
    if (action) {
      if (!this.chat) {
        this.logger.error(`QQ adapter received ${source} event before initialize()`);
        return "not_initialized";
      }

      const thread = this.decodeThreadId(action.threadId);
      this.updatePassiveContext(action.threadId, {
        _chat_thread_id: toThreadStorageId(thread),
        _chat_thread_type: thread.type,
        event_id: this.resolvePayloadEventId(payload),
      });
      await this.acknowledgeInteraction(action.triggerId);
      const actionEvent: Parameters<ChatInstance["processAction"]>[0] = {
        actionId: action.actionId,
        adapter: this,
        messageId: action.messageId,
        raw: action.raw,
        threadId: action.threadId,
        triggerId: action.triggerId,
        user: action.user,
        ...(action.value !== undefined ? { value: action.value } : {}),
      };
      this.chat.processAction(actionEvent, options);
      return "handled";
    }

    const platformEvent = this.extractPlatformEvent(payload);
    if (platformEvent) {
      this.dispatchPlatformEvent(platformEvent, options);
      return "handled";
    }

    if (payload.t === "READY" || payload.t === "RESUMED") {
      this.logger.debug("Ignoring QQ gateway lifecycle event", {
        eventId: this.resolvePayloadEventId(payload),
        source,
        type: payload.t,
      });
      return "ignored";
    }

    this.logger.info("Ignoring unsupported QQ dispatch event", {
      eventId: this.resolvePayloadEventId(payload),
      op: payload.op,
      source,
      type: payload.t ?? "unknown",
    });
    return "unsupported";
  }

  private async handleValidationChallenge(payload: QQWebhookPayload<unknown>): Promise<Response> {
    if (!isValidationPayload(payload.d)) {
      return this.createWebhookErrorResponse(
        400,
        "INVALID_VALIDATION_PAYLOAD",
        "Validation payload is missing required fields.",
      );
    }

    const keys = await this.getSigningKeys();
    const signatureBytes = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new Uint8Array(stringToBytes(`${payload.d.event_ts}${payload.d.plain_token}`)),
    );
    const signature = bytesToHex(new Uint8Array(signatureBytes));
    this.logger.debug("QQ webhook validation challenge signed", {
      eventTs: payload.d.event_ts,
      plainTokenLength: payload.d.plain_token.length,
      signatureLength: signature.length,
    });

    return Response.json(
      {
        plain_token: payload.d.plain_token,
        signature,
      },
    );
  }

  private async verifyWebhookSignature(headers: Headers, rawBody: string): Promise<SignatureCheckResult> {
    const signatureHex = headers.get(SIGNATURE_HEADER);
    const timestampHeader = headers.get(SIGNATURE_TIMESTAMP_HEADER);
    if (!signatureHex || !timestampHeader) {
      return {
        ok: false,
        reason: "Missing webhook signature headers.",
      };
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        reason: "Invalid signature timestamp.",
      };
    }

    const replayWindowSec = this.config.webhookReplayWindowSec ?? 300;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > replayWindowSec) {
      return {
        ok: false,
        reason: "Signature timestamp is outside the allowed replay window.",
      };
    }

    try {
      if (!/^[\da-f]+$/i.test(signatureHex) || signatureHex.length !== QQ_SIGNATURE_SIZE * 2) {
        return {
          ok: false,
          reason: "Invalid signature encoding.",
        };
      }

      const signature = hexToBytes(signatureHex);
      const lastSignatureByte = signature[QQ_SIGNATURE_SIZE - 1];
      if (signature.length !== QQ_SIGNATURE_SIZE || lastSignatureByte === undefined || (lastSignatureByte & 0xe0) !== 0) {
        return {
          ok: false,
          reason: "Invalid signature length.",
        };
      }

      const keys = await this.getSigningKeys();
      const valid = await crypto.subtle.verify(
        "Ed25519",
        keys.publicKey,
        new Uint8Array(signature),
        new Uint8Array(stringToBytes(`${timestampHeader}${rawBody}`)),
      );
      if (!valid) {
        return {
          ok: false,
          reason: "Signature verification failed.",
        };
      }

      return { ok: true };
    } catch (error) {
      this.logger.warn("QQ signature verification failed", error);
      return {
        ok: false,
        reason: "Signature verification threw an exception.",
      };
    }
  }

  private createWebhookErrorResponse(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response {
    return Response.json(
      {
        error: {
          code,
          details,
          message,
        },
      },
      { status },
    );
  }

  private async getSigningKeys(): Promise<SigningKeys> {
    if (this.signingKeysCache) {
      return this.signingKeysCache;
    }

    const seed = createBotSeed(
      this.config.botSecret?.trim() || this.config.clientSecret,
    );

    const pkcs8Der = new Uint8Array(concatBytes(ED25519_PRIVATE_KEY_DER_PREFIX, seed));
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8Der,
      "Ed25519",
      true,
      ["sign"],
    );

    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x!, ext: true },
      "Ed25519",
      false,
      ["verify"],
    );

    this.signingKeysCache = { privateKey, publicKey };
    return this.signingKeysCache;
  }

  private createCallbackAckResponse(seq?: number): Response {
    const data = typeof seq === "number" ? { seq } : undefined;
    return Response.json({ d: data, op: CALLBACK_ACK_OPCODE });
  }

  private resolvePayloadEventId(payload: QQWebhookPayload<unknown>): string {
    return payload.id ?? `${payload.t ?? "event"}:${payload.s ?? "unknown"}`;
  }

  private extractMessageEvent(payload: QQWebhookPayload<unknown>): ParsedMessageEvent | null {
    if (!isQQMessageEventType(payload.t)) {
      return null;
    }
    if (!payload.d || typeof payload.d !== "object") {
      return null;
    }

    const raw = payload.d as QQMessageEventDataMap[typeof payload.t];
    const thread = this.resolveThreadFromEvent(payload.t, raw);
    if (!thread) {
      return null;
    }

    const threadId = this.encodeThreadId(thread);
    const normalizedRaw: QQRawMessage = {
      ...raw,
      ...this.getQuotedMessageFields(raw),
      _chat_event_type: payload.t,
      _chat_is_mention: this.isMentionEvent(payload.t, raw),
      _chat_thread_id: toThreadStorageId(thread),
      _chat_thread_type: thread.type,
      event_id: raw.event_id ?? payload.id,
    };
    this.logMessageElements(payload.t, normalizedRaw);

    return { raw: normalizedRaw, threadId };
  }

  private extractActionEvent(payload: QQWebhookPayload<unknown>): ParsedActionEvent | null {
    if (!isQQActionEventType(payload.t)) {
      return null;
    }
    if (!payload.d || typeof payload.d !== "object") {
      return null;
    }

    const raw = payload.d as QQActionEventDataMap[typeof payload.t];
    const thread = this.resolveThreadFromInteraction(raw);
    if (!thread) {
      this.logger.warn("QQ interaction event is missing thread identifiers", {
        chatType: raw.chat_type,
        groupOpenIdPresent: Boolean(raw.group_openid),
        openIdPresent: Boolean(raw.openid),
        scene: raw.scene,
        userOpenIdPresent: Boolean(raw.user_openid),
      });
      return null;
    }

    const resolved = raw.data?.resolved;
    const actionId = resolved?.button_id ?? resolved?.feature_id ?? resolved?.button_data;
    if (!actionId) {
      this.logger.warn("QQ interaction event is missing button action data", {
        buttonDataPresent: Boolean(resolved?.button_data),
        buttonIdPresent: Boolean(resolved?.button_id),
        featureIdPresent: Boolean(resolved?.feature_id),
        interactionId: raw.id ?? this.resolvePayloadEventId(payload),
      });
      return null;
    }

    const authorId = this.resolveInteractionAuthorId(raw);
    const event: ParsedActionEvent = {
      actionId,
      messageId: resolved?.message_id ?? raw.message_id ?? this.resolvePayloadEventId(payload),
      raw,
      threadId: this.encodeThreadId(thread),
      triggerId: raw.id ?? this.resolvePayloadEventId(payload),
      user: {
        fullName: authorId,
        isBot: false,
        isMe: false,
        userId: authorId,
        userName: authorId,
      },
    };
    if (resolved?.button_data !== undefined) {
      event.value = resolved.button_data;
    }
    return event;
  }

  private extractPlatformEvent(payload: QQWebhookPayload<unknown>): QQPlatformEvent | null {
    if (!isQQPlatformEventType(payload.t)) {
      return null;
    }

    let threadId: string | undefined;
    if (payload.d && typeof payload.d === "object") {
      const raw = payload.d as QQPlatformEventDataMap[typeof payload.t];
      const thread = this.resolveThreadFromEvent(payload.t, raw);
      if (thread) {
        threadId = this.encodeThreadId(thread);
        this.updatePassiveContext(threadId, {
          _chat_thread_id: toThreadStorageId(thread),
          _chat_thread_type: thread.type,
          event_id: this.resolvePayloadEventId(payload),
        });
      }
    }

    const typedPayload = payload as QQWebhookPayload<QQPlatformEventDataMap[typeof payload.t], typeof payload.t>;
    return {
      ...(threadId !== undefined ? { threadId } : {}),
      data: typedPayload.d,
      eventId: this.resolvePayloadEventId(payload),
      payload: typedPayload,
      type: payload.t,
    };
  }

  private dispatchPlatformEvent(event: QQPlatformEvent, options?: WebhookOptions): void {
    const handlers = [
      ...this.platformEventCatchAllHandlers,
      ...(this.platformEventHandlers.get(event.type) ?? []),
    ];
    if (handlers.length === 0) {
      return;
    }

    const task = Promise.all(
      handlers.map(async (handler) => {
        await handler(event);
      }),
    ).catch((error) => {
      this.logger.error("QQ platform event handler failed", error);
    });
    if (options?.waitUntil) {
      options.waitUntil(task);
    }
  }

  private processSlashCommand(threadId: string, message: Message<QQRawMessage>, options?: WebhookOptions): boolean {
    if (!this.chat) {
      return false;
    }

    const slashText = this.normalizeSlashCommandText(message);
    if (!slashText.startsWith("/")) {
      return false;
    }

    const [command = "", ...args] = slashText.trim().split(/\s+/);
    if (!command || command === "/") {
      return false;
    }

    this.chat.processSlashCommand(
      {
        adapter: this,
        channelId: threadId,
        command,
        raw: message.raw,
        text: args.join(" "),
        triggerId: message.id,
        user: message.author,
      },
      options,
    );
    return true;
  }

  private normalizeSlashCommandText(message: Message<QQRawMessage>): string {
    let text = message.text.trimStart();
    if (message.raw._chat_is_mention !== true) {
      return text;
    }

    let previous: string;
    do {
      previous = text;
      text = text
        .replace(/^<@!?[^>\s]+>\s*/u, "")
        .replace(/^<qqbot-at-user\s+id=(?:"[^"]+"|'[^']+')[^>]*\/>\s*/u, "")
        .replace(/^@\S+\s+/u, "")
        .trimStart();
    } while (text !== previous);

    return text;
  }

  private async acknowledgeInteraction(interactionId: string): Promise<void> {
    if (this.config.acknowledgeInteractions === false) {
      return;
    }

    this.logger.debug("QQ interaction ACK request started", {
      interactionId,
    });
    const startedAt = performance.now();
    try {
      await this.apiRequest(`/interactions/${encodeURIComponent(interactionId)}`, {
        body: JSON.stringify({ code: 0 }),
        method: "PUT",
      });
      this.logger.debug("QQ interaction ACK succeeded", {
        elapsedMs: Math.round(performance.now() - startedAt),
        interactionId,
      });
    } catch (error) {
      this.logger.warn("QQ interaction ACK failed", {
        elapsedMs: Math.round(performance.now() - startedAt),
        error,
        interactionId,
      });
    }
  }

  private resolveThreadFromEvent(
    eventType: QQMessageEventType | QQPlatformEventType,
    raw: QQIncomingMessage | QQThreadResolvableEventData,
  ): QQThreadId | null {
    const groupOpenId = raw.group_openid ?? raw.group_id;
    if (eventType.startsWith("GROUP_") || groupOpenId) {
      return groupOpenId ? { groupOpenId, type: "group" } : null;
    }
    const userOpenId = raw.author?.user_openid ?? raw.user_openid ?? raw.openid;
    return userOpenId ? { type: "c2c", userOpenId } : null;
  }

  private isMentionEvent(eventType: QQMessageEventType, raw: QQIncomingMessage): boolean {
    if (eventType === "C2C_MESSAGE_CREATE" || eventType === "GROUP_AT_MESSAGE_CREATE") {
      return true;
    }
    return raw.mentions?.some((mention) => mention.is_you === true) === true;
  }

  private resolveThreadFromInteraction(raw: QQInteractionPayload): QQThreadId | null {
    const groupOpenId = raw.group_openid;
    if (raw.scene === "group" || raw.chat_type === 1 || groupOpenId) {
      return groupOpenId ? { groupOpenId, type: "group" } : null;
    }
    if (raw.scene === "guild" || raw.chat_type === 0) {
      return null;
    }

    const userOpenId = raw.user_openid ?? raw.openid ?? raw.data?.resolved?.user_id;
    return userOpenId ? { type: "c2c", userOpenId } : null;
  }

  private resolveInteractionAuthorId(raw: QQInteractionPayload): string {
    return raw.group_member_openid ?? raw.user_openid ?? raw.openid ?? raw.data?.resolved?.user_id ?? "unknown";
  }

  private resolveThreadFromRaw(raw: QQRawMessage): QQThreadId {
    if (raw._chat_thread_type && raw._chat_thread_id) {
      return fromThreadStorage(raw._chat_thread_type, raw._chat_thread_id);
    }

    const groupOpenId = raw.group_openid ?? raw.group_id;
    if (groupOpenId) {
      return { groupOpenId, type: "group" };
    }

    const userOpenId = raw.author?.user_openid ?? raw.user_openid ?? raw.openid;
    if (!userOpenId) {
      throw new Error("Unable to resolve QQ thread from raw message.");
    }
    return { type: "c2c", userOpenId };
  }

  private resolveAuthorId(raw: QQRawMessage): string {
    return raw.author?.member_openid ?? raw.author?.user_openid ?? raw.author?.id ?? "unknown";
  }

  private getQuotedMessageFields(raw: QQIncomingMessage): Pick<QQRawMessage, "_chat_quoted_message"> {
    const quotedMessage = this.resolveQuotedMessage(raw);
    return quotedMessage ? { _chat_quoted_message: quotedMessage } : {};
  }

  private resolveQuotedMessage(raw: QQIncomingMessage): QQQuotedMessage | null {
    const refMsgIdx = findMessageSceneValue(raw.message_scene?.ext, "ref_msg_idx");
    if (!refMsgIdx) {
      return null;
    }

    const element = raw.msg_elements?.find((item) => item.msg_idx === refMsgIdx);
    return {
      ...(element?.content !== undefined ? { content: element.content } : {}),
      ...(element?.message_type !== undefined ? { messageType: element.message_type } : {}),
      msgIdx: refMsgIdx,
    };
  }

  private logMessageElements(eventType: QQMessageEventType, raw: QQRawMessage): void {
    if (!raw.msg_elements?.length && !raw._chat_quoted_message) {
      return;
    }

    this.logger.debug("QQ message elements received", {
      eventType,
      messageId: raw.id ?? raw.msg_id,
      msgElements: raw.msg_elements,
      quotedMessage: raw._chat_quoted_message,
    });
  }

  private getOutboundAuthor(type: QQThreadType): NonNullable<QQRawMessage["author"]> {
    switch (type) {
      case "group":
        return {
          bot: true,
          id: this.config.appId,
          username: this.userName,
        };
      case "c2c":
      case "guild_channel":
        return {
          bot: true,
          id: this.config.appId,
          username: this.userName,
        };
      default:
        return assertNever(type);
    }
  }

  private assertFeature(thread: QQThreadId, feature: QQFeature): void {
    if (FEATURE_SUPPORT[feature].has(thread.type)) {
      return;
    }
    throw new NotImplementedError(`Feature ${feature} is not supported in scene: ${thread.type}`, feature);
  }

  private async buildSendPayloads(
    threadId: string,
    thread: QQThreadId,
    message: AdapterPostableMessage,
    options: QQSendMessageOptions = {},
  ): Promise<QQSendMessageRequest[]> {
    const payload = buildMessageContentPayload(this.converter, message);
    const attachments = getPostableAttachments(message);
    if (attachments.length === 0) {
      return [this.applySendOptions(threadId, thread, payload, options)];
    }

    const payloads: QQSendMessageRequest[] = [];
    if (hasSendCaption(payload)) {
      payloads.push(this.applySendOptions(threadId, thread, payload, options));
    }

    for (const [index, attachment] of attachments.entries()) {
      const media = await this.uploadMedia(thread, attachment);
      const mediaOptions = payloads.length === 0 && index === 0
        ? options
        : { ...options, messageReference: undefined };
      payloads.push(this.applySendOptions(threadId, thread, {
        media,
        msg_type: 7,
      }, mediaOptions));
    }
    return payloads;
  }

  private applySendOptions(
    threadId: string,
    thread: QQThreadId,
    payload: QQSendMessageRequest,
    options: QQSendMessageOptions,
  ): QQSendMessageRequest {
    if (options.isWakeup) {
      if (thread.type !== "c2c") {
        throw new ChatError("QQ `isWakeup` is only valid for C2C messages.", "INVALID_REQUEST");
      }
      payload.is_wakeup = true;
    }
    if (options.messageReference) {
      payload.message_reference = options.messageReference;
    }
    if (options.passiveContext !== false && !options.isWakeup) {
      return this.withPassiveContext(threadId, payload);
    }
    return payload;
  }

  private withPassiveContext(threadId: string, payload: QQSendMessageRequest): QQSendMessageRequest {
    const context = this.passiveContextByThread.get(threadId);
    if (context?.msgId) {
      payload.msg_id = context.msgId;
      payload.msg_seq = context.nextMsgSeq;
      context.nextMsgSeq += 1;
    } else if (context?.eventId) {
      payload.event_id = context.eventId;
    }

    return payload;
  }

  private async uploadMedia(thread: QQThreadId, attachment: Attachment): Promise<QQMediaPayload> {
    let cacheSource: string;
    let data: Uint8Array | undefined;
    if (attachment.url) {
      cacheSource = `url:${attachment.url}`;
    } else {
      data = await this.readAttachmentData(attachment);
      cacheSource = `data:${await sha256Hex(data)}`;
    }

    const size = data?.byteLength ?? attachment.size;
    const fileType = resolveQQMediaFileType(thread, attachment, size);
    const cacheKey = `${thread.type}:${fileType}:${cacheSource}`;
    const cached = this.getCachedMedia(cacheKey);
    if (cached) {
      return cached;
    }

    const uploaded = data && this.shouldUseChunkedUpload(data.byteLength)
      ? await this.uploadMediaChunked(thread, attachment, data, fileType)
      : await this.uploadMediaSimple(thread, attachment, data, fileType);
    const media = this.toMediaPayload(uploaded);
    this.setCachedMedia(cacheKey, media);
    return media;
  }

  private shouldUseChunkedUpload(size: number): boolean {
    const threshold = this.config.chunkedUploadThresholdBytes ?? DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES;
    return size > threshold;
  }

  private async uploadMediaSimple(
    thread: QQThreadId,
    attachment: Attachment,
    data: Uint8Array | undefined,
    fileType: number,
  ): Promise<QQMediaUploadResponse> {
    const request: QQMediaUploadRequest = {
      file_type: fileType,
      srv_send_msg: false,
      ...(attachment.name ? { file_name: attachment.name } : {}),
    };
    if (attachment.url) {
      request.url = attachment.url;
    } else if (data) {
      request.file_data = bytesToBase64(data);
    }

    return this.apiRequest<QQMediaUploadResponse>(getUploadMediaPath(thread), {
      body: JSON.stringify(request),
      method: "POST",
    });
  }

  private async uploadMediaChunked(
    thread: QQThreadId,
    attachment: Attachment,
    data: Uint8Array,
    fileType: number,
  ): Promise<QQMediaUploadResponse> {
    return uploadLocalFileChunked(thread, data, {
      api: {
        put: (url, body) => this.putPresigned(url, body),
        request: (path, init) => this.apiRequest(path, init),
      },
      fileName: attachment.name ?? "file",
      fileType,
    });
  }

  private async putPresigned(url: string, body: Uint8Array): Promise<void> {
    const timeoutMs = Math.max(
      this.config.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
      this.config.requestTimeoutMs ?? 10_000,
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        body: bytesToArrayBuffer(body),
        headers: {
          "Content-Length": String(body.byteLength),
        },
        method: "PUT",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ChatError(`QQ chunked upload PUT failed (${response.status}) at ${url}`, "NETWORK_ERROR");
      }
    } catch (error) {
      if (error instanceof ChatError || error instanceof RateLimitError) {
        throw error;
      }
      throw new ChatError(`QQ chunked upload PUT failed at ${url}`, "NETWORK_ERROR", error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private toMediaPayload(media: QQMediaUploadResponse): QQMediaPayload {
    return {
      file_info: media.file_info,
      ...(media.file_uuid !== undefined ? { file_uuid: media.file_uuid } : {}),
      ...(media.ttl !== undefined ? { ttl: media.ttl } : {}),
    };
  }

  private getCachedMedia(cacheKey: string): QQMediaPayload | null {
    const cached = this.mediaCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      this.mediaCache.delete(cacheKey);
      return null;
    }
    return cached.media;
  }

  private setCachedMedia(cacheKey: string, media: QQMediaPayload): void {
    if (media.ttl === undefined) {
      return;
    }
    this.mediaCache.set(cacheKey, {
      expiresAt: media.ttl === 0 ? null : Date.now() + media.ttl * 1000,
      media,
    });
  }

  private async readAttachmentData(attachment: Attachment): Promise<Uint8Array> {
    const data = attachment.data ?? await attachment.fetchData?.();
    if (!data) {
      throw new NotImplementedError("QQ media messages require URL-based or binary attachment data.", "attachments");
    }
    if (data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new NotImplementedError("QQ media messages require Blob or binary attachment data.", "attachments");
  }

  private updatePassiveContext(threadId: string, raw: QQRawMessage): void {
    const eventId = raw.event_id;
    const msgId = raw.msg_id ?? raw.id;

    if (!eventId && !msgId) {
      return;
    }

    const context = this.passiveContextByThread.get(threadId);
    if (context) {
      if (msgId && msgId !== context.msgId) {
        context.msgId = msgId;
        context.nextMsgSeq = 1;
      }
      if (eventId && eventId !== context.eventId) {
        context.eventId = eventId;
      }
      return;
    }

    this.passiveContextByThread.set(threadId, {
      ...(eventId ? { eventId } : {}),
      ...(msgId ? { msgId, nextMsgSeq: 1 } : { nextMsgSeq: 1 }),
    });
  }

  private cacheMessage(message: Message<QQRawMessage>): void {
    const cache = this.messageCache.get(message.threadId) ?? [];
    cache.push(message);
    if (cache.length > MAX_CACHE_MESSAGES_PER_THREAD) {
      cache.splice(0, cache.length - MAX_CACHE_MESSAGES_PER_THREAD);
    }
    this.messageCache.set(message.threadId, cache);
  }

  private async getAccessToken(): Promise<string> {
    const cached = this.accessTokenCache;
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.token;
    }

    try {
      return await this.fetchAndCacheAccessToken(this.tokenEndpoint);
    } catch (error) {
      if (!this.canFallbackTokenHost(error) || !this.fallbackTokenEndpoint) {
        throw error;
      }

      const fallbackTokenEndpoint = this.fallbackTokenEndpoint;
      this.logger.warn("QQ token host failed; trying compatibility endpoint", {
        error,
        fallback: fallbackTokenEndpoint,
        tokenEndpoint: this.tokenEndpoint,
      });
      const token = await this.fetchAndCacheAccessToken(fallbackTokenEndpoint);
      this.tokenEndpoint = fallbackTokenEndpoint;
      if (this.fallbackApiBaseUrl) {
        this.apiBaseUrl = this.fallbackApiBaseUrl;
      }
      this.fallbackApiBaseUrl = undefined;
      this.fallbackTokenEndpoint = undefined;
      return token;
    }
  }

  private canFallbackTokenHost(error: unknown): boolean {
    return error instanceof ChatError && (error.code === "NETWORK_ERROR" || error.code === "NOT_FOUND");
  }

  private async fetchAndCacheAccessToken(endpoint: string): Promise<string> {
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          appId: this.config.appId,
          clientSecret: this.config.clientSecret,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: controller.signal,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw toChatError({
          endpoint,
          message: `QQ token request failed (${response.status})`,
          retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
          responseBody: bodyText,
          status: response.status,
        });
      }

      const data = JSON.parse(bodyText) as QQAccessTokenResponse;
      if (!data.access_token) {
        throw new ChatError(`QQ token response missing access_token at ${endpoint}`, "AUTH_FAILED");
      }

      const expiresInSeconds = Number(data.expires_in || 7200);
      this.accessTokenCache = {
        expiresAt: Date.now() + expiresInSeconds * 1000,
        token: data.access_token,
      };
      return data.access_token;
    } catch (error) {
      if (error instanceof ChatError || error instanceof RateLimitError) {
        throw error;
      }
      throw new ChatError(`QQ token request failed at ${endpoint}`, "NETWORK_ERROR", error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchGatewayBot(): Promise<QQGatewayBotResponse> {
    return this.apiRequest<QQGatewayBotResponse>("/gateway/bot", { method: "GET" });
  }

  private async apiRequest<T = unknown>(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<T> {
    return (await this.apiRequestWithMeta<T>(path, init)).body;
  }

  private async apiRequestWithMeta<T = unknown>(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<ApiRequestResult<T>> {
    const token = await this.getAccessToken();
    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const endpoint = `${this.apiBaseUrl}${path}`;
      const response = await fetch(endpoint, {
        ...init,
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
          "X-Union-Appid": this.config.appId,
          ...init.headers,
        },
        signal: controller.signal,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw toChatError({
          endpoint,
          message: `QQ API request failed (${response.status})`,
          retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
          responseBody: bodyText,
          status: response.status,
        });
      }

      if (!bodyText) {
        return { body: {} as T, status: response.status };
      }

      const body = JSON.parse(bodyText) as T;
      const businessCode = getQQBusinessCode(body);
      if (businessCode !== undefined && businessCode !== 0 && response.status !== 201 && response.status !== 202) {
        throw toChatError({
          endpoint,
          message: `QQ API request failed (${response.status})`,
          retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
          responseBody: bodyText,
          status: response.status,
        });
      }
      return { body, status: response.status };
    } catch (error) {
      if (error instanceof ChatError || error instanceof RateLimitError) {
        throw error;
      }
      throw new ChatError(`QQ API network failure at ${this.apiBaseUrl}${path}`, "NETWORK_ERROR", error);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function getQQBusinessCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const value = record.code ?? record.errcode;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}
