import type {
  Adapter,
  AdapterPostableMessage,
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
  ACTION_EVENT_TYPES,
  CALLBACK_ACK_OPCODE,
  CALLBACK_DISPATCH_OPCODE,
  CALLBACK_VALIDATION_OPCODE,
  DEFAULT_API_BASE_URL,
  DEFAULT_FETCH_LIMIT,
  DEFAULT_TOKEN_ENDPOINT,
  FEATURE_SUPPORT,
  MAX_CACHE_MESSAGES_PER_THREAD,
  MESSAGE_EVENT_TYPES,
  PLATFORM_EVENT_TYPES,
  SANDBOX_API_BASE_URL,
  SIGNATURE_HEADER,
  SIGNATURE_TIMESTAMP_HEADER,
  type QQFeature,
} from "./constants";
import { QQFormatConverter } from "./format-converter.js";
import type {
  QQAccessTokenResponse,
  QQAdapterConfig,
  QQIncomingMessage,
  QQInteractionPayload,
  QQPlatformEvent,
  QQPlatformEventHandler,
  QQPlatformEventType,
  QQRawMessage,
  QQSendMessageRequest,
  QQThreadType,
  QQThreadId,
  QQWebhookPayload,
} from "./types.js";
import {
  buildMessageContentPayload,
  getDeleteMessagePath,
  getPostMessagePath,
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
  bytesToHex,
  concatBytes,
  createBotSeed,
  hexToBytes,
  isValidationPayload,
  parseCursor,
  parseQQTimestamp,
  stringToBytes,
  toChatError,
} from "./utils/index.js";

interface AccessTokenCache {
  expiresAt: number;
  token: string;
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
  readonly userName: string;
  readonly botUserId?: string;

  private chat: ChatInstance | null = null;
  private readonly apiBaseUrl: string;
  private readonly config: QQAdapterConfig;
  private readonly converter = new QQFormatConverter();
  private readonly logger: Logger;
  private readonly platformEventHandlers = new Map<QQPlatformEventType, Set<QQPlatformEventHandler>>();
  private readonly platformEventCatchAllHandlers = new Set<QQPlatformEventHandler>();
  private readonly messageCache = new Map<string, Message<QQRawMessage>[]>();
  private readonly passiveContextByThread = new Map<string, PassiveContext>();
  private accessTokenCache: AccessTokenCache | null = null;
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
    this.botUserId = config.botUserId;
    this.logger = config.logger ?? new ConsoleLogger();
    this.apiBaseUrl = config.apiBaseUrl ?? (config.sandbox ? SANDBOX_API_BASE_URL : DEFAULT_API_BASE_URL);
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
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

      const event = this.extractMessageEvent(payload);
      if (event) {
        if (!this.chat) {
          this.logger.error("QQ adapter received webhook before initialize()");
          return this.createWebhookErrorResponse(500, "ADAPTER_NOT_INITIALIZED", "Adapter is not initialized.");
        }

        const message = this.parseMessage(event.raw);
        this.cacheMessage(message);
        this.updatePassiveContext(event.threadId, event.raw);
        if (this.processSlashCommand(event.threadId, message, options)) {
          return this.createCallbackAckResponse(payload.s);
        }
        this.chat.processMessage(this, event.threadId, message, options);
        return this.createCallbackAckResponse(payload.s);
      }

      const action = this.extractActionEvent(payload);
      if (action) {
        if (!this.chat) {
          this.logger.error("QQ adapter received webhook before initialize()");
          return this.createWebhookErrorResponse(500, "ADAPTER_NOT_INITIALIZED", "Adapter is not initialized.");
        }

        const thread = this.decodeThreadId(action.threadId);
        this.updatePassiveContext(action.threadId, {
          _chat_thread_id: toThreadStorageId(thread),
          _chat_thread_type: thread.type,
          event_id: payload.id,
        });
        await this.acknowledgeInteraction(action.triggerId);
        this.chat.processAction(
          {
            actionId: action.actionId,
            adapter: this,
            messageId: action.messageId,
            raw: action.raw,
            threadId: action.threadId,
            triggerId: action.triggerId,
            user: action.user,
            value: action.value,
          },
          options,
        );
        return this.createCallbackAckResponse(payload.s);
      }

      const platformEvent = this.extractPlatformEvent(payload);
      if (platformEvent) {
        this.dispatchPlatformEvent(platformEvent, options);
        return this.createCallbackAckResponse(payload.s);
      }

      {
        this.logger.info("Ignoring unsupported QQ webhook dispatch event", {
          eventId: payload.id,
          op: payload.op,
          type: payload.t ?? "unknown",
        });

        if (this.config.strictWebhookEvents) {
          return this.createWebhookErrorResponse(400, "UNSUPPORTED_EVENT", "Unsupported webhook dispatch event.", {
            eventId: payload.id,
            type: payload.t ?? "unknown",
          });
        }
        return this.createCallbackAckResponse(payload.s);
      }
    } catch (error) {
      this.logger.error("QQ webhook handling failed", error);
      return this.createWebhookErrorResponse(500, "WEBHOOK_INTERNAL_ERROR", "Internal webhook handler error.");
    }
  }

  parseMessage(raw: QQRawMessage): Message<QQRawMessage> {
    const thread = this.resolveThreadFromRaw(raw);
    const threadId = this.encodeThreadId(thread);
    const content = raw.content ?? "";
    const authorId = this.resolveAuthorId(raw);
    const isMe = raw._chat_is_outbound === true || (this.botUserId ? authorId === this.botUserId : false);
    const dateSent = parseQQTimestamp(raw.timestamp, true);
    const editedAt = parseQQTimestamp(raw.edited_timestamp, false);

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
      metadata: {
        dateSent,
        edited: Boolean(editedAt),
        editedAt: editedAt ?? undefined,
      },
      raw,
      text: this.converter.extractPlainText(content),
      threadId,
    });
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<QQRawMessage>> {
    validateMessagePayload(message);
    const thread = this.decodeThreadId(threadId);
    this.assertFeature(thread, "postMessage");
    const payload = this.buildSendPayload(threadId, message);
    const path = getPostMessagePath(thread);

    const sentRaw = await this.apiRequest<QQRawMessage>(path, {
      body: JSON.stringify(payload),
      method: "POST",
    });

    const enrichedRaw: QQRawMessage = {
      ...sentRaw,
      _chat_is_outbound: true,
      _chat_thread_id: toThreadStorageId(thread),
      _chat_thread_type: thread.type,
      author: sentRaw.author ?? this.getOutboundAuthor(thread.type),
      content: sentRaw.content ?? payload.content ?? payload.markdown?.content,
      id: sentRaw.id ?? crypto.randomUUID(),
      msg_id: sentRaw.msg_id ?? payload.msg_id,
      timestamp: sentRaw.timestamp ?? new Date().toISOString(),
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

  async startTyping(_threadId: string, _status?: string): Promise<void> {
    return;
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<QQRawMessage>> {
    let content = "";
    for await (const chunk of textStream) {
      content += streamChunkToText(chunk);
    }

    return this.postMessage(threadId, content || " ");
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
        nextCursor: end < all.length ? String(end) : undefined,
      };
    }

    const end = Math.max(0, Math.min(all.length, cursorIndex ?? all.length));
    const start = Math.max(0, end - limit);
    return {
      messages: all.slice(start, end),
      nextCursor: start > 0 ? String(start) : undefined,
    };
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
      if (signature.length !== QQ_SIGNATURE_SIZE || (signature[QQ_SIGNATURE_SIZE - 1] & 0xe0) !== 0) {
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

  private extractMessageEvent(payload: QQWebhookPayload<unknown>): ParsedMessageEvent | null {
    if (!payload.t || !MESSAGE_EVENT_TYPES.has(payload.t)) {
      return null;
    }
    if (!payload.d || typeof payload.d !== "object") {
      return null;
    }

    const raw = payload.d as QQIncomingMessage;
    const thread = this.resolveThreadFromEvent(payload.t, raw);
    if (!thread) {
      return null;
    }

    const threadId = this.encodeThreadId(thread);
    const normalizedRaw: QQRawMessage = {
      ...raw,
      _chat_thread_id: toThreadStorageId(thread),
      _chat_thread_type: thread.type,
    };

    return { raw: normalizedRaw, threadId };
  }

  private extractActionEvent(payload: QQWebhookPayload<unknown>): ParsedActionEvent | null {
    if (!payload.t || !ACTION_EVENT_TYPES.has(payload.t)) {
      return null;
    }
    if (!payload.d || typeof payload.d !== "object") {
      return null;
    }

    const raw = payload.d as QQInteractionPayload;
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
    const actionId = resolved?.button_id ?? resolved?.button_data;
    if (!actionId) {
      this.logger.warn("QQ interaction event is missing button action data", {
        buttonDataPresent: Boolean(resolved?.button_data),
        buttonIdPresent: Boolean(resolved?.button_id),
        interactionId: raw.id ?? payload.id,
      });
      return null;
    }

    const authorId = this.resolveInteractionAuthorId(raw);
    return {
      actionId,
      messageId: resolved?.message_id ?? raw.message_id ?? payload.id,
      raw,
      threadId: this.encodeThreadId(thread),
      triggerId: raw.id ?? payload.id,
      user: {
        fullName: authorId,
        isBot: false,
        isMe: this.botUserId ? authorId === this.botUserId : false,
        userId: authorId,
        userName: authorId,
      },
      value: resolved?.button_data,
    };
  }

  private extractPlatformEvent(payload: QQWebhookPayload<unknown>): QQPlatformEvent | null {
    if (!payload.t || !PLATFORM_EVENT_TYPES.has(payload.t)) {
      return null;
    }

    let threadId: string | undefined;
    if (payload.d && typeof payload.d === "object") {
      const raw = payload.d as QQIncomingMessage;
      const thread = this.resolveThreadFromEvent(payload.t, raw);
      if (thread) {
        threadId = this.encodeThreadId(thread);
        this.updatePassiveContext(threadId, {
          _chat_thread_id: toThreadStorageId(thread),
          _chat_thread_type: thread.type,
          event_id: payload.id,
        });
      }
    }

    return {
      data: payload.d,
      eventId: payload.id,
      payload,
      threadId,
      type: payload.t as QQPlatformEventType,
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
    if (!this.chat || !message.text.startsWith("/")) {
      return false;
    }

    const [command = "", ...args] = message.text.trim().split(/\s+/);
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

  private resolveThreadFromEvent(eventType: string, raw: QQIncomingMessage): QQThreadId | null {
    if (eventType.startsWith("GROUP_")) {
      const groupOpenId = raw.group_openid ?? raw.group_id;
      return groupOpenId ? { groupOpenId, type: "group" } : null;
    }
    const userOpenId = raw.author?.user_openid ?? raw.user_openid ?? raw.openid;
    return userOpenId ? { type: "c2c", userOpenId } : null;
  }

  private resolveThreadFromInteraction(raw: QQInteractionPayload): QQThreadId | null {
    const groupOpenId = raw.group_openid;
    if (raw.scene === "group" || raw.chat_type === 1 || groupOpenId) {
      return groupOpenId ? { groupOpenId, type: "group" } : null;
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
    return raw.author?.member_openid ?? raw.author?.user_openid ?? raw.author?.id ?? this.botUserId ?? "unknown";
  }

  private getOutboundAuthor(type: QQThreadType): NonNullable<QQRawMessage["author"]> {
    switch (type) {
      case "group":
        return {
          member_openid: this.botUserId,
          username: this.userName,
        };
      case "c2c":
      case "guild_channel":
        return {
          user_openid: this.botUserId,
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

  private buildSendPayload(threadId: string, message: AdapterPostableMessage): QQSendMessageRequest {
    const payload = buildMessageContentPayload(this.converter, message);

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

  private updatePassiveContext(threadId: string, raw: QQRawMessage): void {
    const eventId = raw.event_id;
    const msgId = raw.msg_id ?? raw.id;

    if (!eventId && !msgId) {
      return;
    }

    const context = this.passiveContextByThread.get(threadId) ?? { nextMsgSeq: 1 };
    if (msgId && msgId !== context.msgId) {
      context.msgId = msgId;
      context.nextMsgSeq = 1;
    }
    if (eventId) {
      context.eventId = eventId;
    }
    this.passiveContextByThread.set(threadId, context);
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

    const timeoutMs = this.config.requestTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const endpoint = this.config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
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
      throw new ChatError(
        `QQ token request failed at ${this.config.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT}`,
        "NETWORK_ERROR",
        error,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async apiRequest<T = Record<string, unknown>>(
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ): Promise<T> {
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
          responseBody: bodyText,
          status: response.status,
        });
      }

      if (!bodyText) {
        return {} as T;
      }

      return JSON.parse(bodyText) as T;
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
