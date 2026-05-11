import type { Logger } from "chat";

/** QQ private chat thread identifier (`/v2/users/{openid}`). */
export interface QQC2CThreadId {
  /** Scene discriminator. */
  type: "c2c";
  /** User openid in QQ C2C scene. */
  userOpenId: string;
}

/** QQ group chat thread identifier (`/v2/groups/{group_openid}`). */
export interface QQGroupThreadId {
  /** Scene discriminator. */
  type: "group";
  /** Group openid in QQ group scene. */
  groupOpenId: string;
}

/** QQ guild channel thread identifier (reserved for channel scene expansion). */
export interface QQGuildChannelThreadId {
  /** Scene discriminator. */
  type: "guild_channel";
  /** Channel id inside the guild. */
  channelId: string;
  /** Guild id that owns the channel. */
  guildId: string;
}

/** Discriminated union for supported QQ thread scenes. */
export type QQThreadId = QQC2CThreadId | QQGroupThreadId | QQGuildChannelThreadId;

/** Convenience union of QQ scene type literals. */
export type QQThreadType = QQThreadId["type"];

/** Runtime transport mode used for receiving QQ events. */
export type QQAdapterMode = "socket" | "webhook";

export type QQSocketModeMessageData = ArrayBuffer | string;

export interface QQSocketModeWebSocket {
  addEventListener(type: "message", listener: (event: MessageEvent<QQSocketModeMessageData>) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error" | "open", listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type QQSocketModeWebSocketFactory = (url: string) => QQSocketModeWebSocket;

export interface QQSocketModeOptions {
  /** Gateway identify properties. Defaults to this package name. */
  properties?: Record<string, string>;
  /** Automatically reconnect after gateway close/reconnect requests. Defaults to true. */
  reconnect?: boolean;
  /** Delay before reconnecting in milliseconds. Defaults to 1000. */
  reconnectDelayMs?: number;
  /** Whether to attempt opcode 6 resume when a session id is available. Defaults to true. */
  resume?: boolean;
  /** Gateway shard tuple. Defaults to [0, 1]. */
  shard?: readonly [number, number];
  /** Explicit WSS URL. When omitted, the adapter calls /gateway/bot. */
  url?: string;
  /** Advanced/test: custom WebSocket factory. Defaults to globalThis.WebSocket. */
  webSocketFactory?: QQSocketModeWebSocketFactory;
  /** Gateway event intents. Defaults to GROUP_AND_C2C_EVENT | INTERACTION. */
  intents?: number;
}

/** QQ adapter runtime configuration. */
export interface QQAdapterBaseConfig {
  /** Advanced: whether to send QQ interaction ACK API calls for button events. Defaults to true. */
  acknowledgeInteractions?: boolean;
  /** Advanced/test: override QQ OpenAPI base URL. */
  apiBaseUrl?: string;
  /** QQ bot app id. */
  appId: string;
  /** Advanced: Bot Secret used for webhook signing; falls back to clientSecret. */
  botSecret?: string;
  /** QQ bot client secret for access token retrieval. */
  clientSecret: string;
  /** Logger implementation from Chat SDK. */
  logger?: Logger;
  /** Advanced security option: whether webhook requests must include and match `X-Bot-Appid`. */
  requireAppIdHeader?: boolean;
  /** HTTP request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Advanced/test: use QQ sandbox OpenAPI domain when true. */
  sandbox?: boolean;
  /** Return 400 for unsupported webhook events instead of ACK. */
  strictWebhookEvents?: boolean;
  /** Advanced/test: override token endpoint for custom environments. */
  tokenEndpoint?: string;
  /** Chat SDK bot username fallback when QQ author payload is incomplete. */
  userName?: string;
  /** Enable Ed25519 webhook signature verification. */
  verifySignature?: boolean;
  /** Allowed webhook timestamp skew in seconds. */
  webhookReplayWindowSec?: number;
}

export interface QQWebhookAdapterConfig extends QQAdapterBaseConfig {
  /** Event receiving mode. Defaults to webhook. */
  mode?: "webhook";
  /** Socket Mode options are only used when mode is socket. */
  socketMode?: never;
}

export interface QQSocketModeAdapterConfig extends QQAdapterBaseConfig {
  /** Start QQ Socket Mode during Chat initialization. */
  mode: "socket";
  /** Socket Mode connection options. */
  socketMode?: QQSocketModeOptions;
}

/** QQ adapter runtime configuration. */
export type QQAdapterConfig = QQSocketModeAdapterConfig | QQWebhookAdapterConfig;

/** Generic QQ webhook/gateway envelope. */
export interface QQWebhookPayload<TData = unknown, TType extends string = string> {
  /** Event data payload. */
  d?: TData;
  /** Callback event id. */
  id?: string;
  /** Callback opcode. */
  op: number;
  /** Sequence number for callback ACK. */
  s?: number;
  /** Event type string, e.g. `GROUP_AT_MESSAGE_CREATE`. */
  t?: TType;
}

/** QQ dispatch event types treated as inbound messages by Chat SDK. */
export type QQMessageEventType = "C2C_MESSAGE_CREATE" | "GROUP_AT_MESSAGE_CREATE";

/** QQ dispatch event types treated as Chat SDK actions. */
export type QQActionEventType = "INTERACTION_CREATE";

/** QQ gateway lifecycle dispatch events. */
export type QQGatewayLifecycleEventType = "READY" | "RESUMED";

/** QQ webhook validation payload (`op=13`). */
export interface QQWebhookValidationData {
  /** QQ event timestamp string. */
  event_ts: string;
  /** Plain token used to compute validation signature. */
  plain_token: string;
}

/** QQ message author object from webhook/OpenAPI payload. */
export interface QQMessageAuthor {
  /** Avatar URL. */
  avatar?: string;
  /** Whether the author is a bot account. */
  bot?: boolean;
  /** Generic author id (guild-like scenes). */
  id?: string;
  /** Member openid in group scene. */
  member_openid?: string;
  /** Display nickname. */
  nick?: string;
  /** User openid in c2c scene. */
  user_openid?: string;
  /** Username/handle. */
  username?: string;
}

/** QQ attachment payload shape. */
export interface QQMessageAttachment {
  /** MIME type. */
  content_type?: string;
  /** File name. */
  filename?: string;
  /** Media height for image-like attachment. */
  height?: number;
  /** File size in bytes. */
  size?: number;
  /** Download URL. */
  url?: string;
  /** Voice file URL in WAV format (voice only). */
  voice_wav_url?: string;
  /** Voice ASR reference text (voice only). */
  asr_refer_text?: string;
  /** Media width for image-like attachment. */
  width?: number;
}

export interface QQMessageElement {
  [key: string]: unknown;
  content?: string;
  message_type?: number;
  msg_idx?: string;
  type?: string;
}

export interface QQMessageScene {
  ext?: string[];
  source?: string;
}

export interface QQQuotedMessage {
  content?: string;
  messageType?: number;
  msgIdx: string;
}

export interface QQMarkdownPayload {
  content?: string;
  custom_template_id?: string;
  params?: Array<{
    key: string;
    values: string[];
  }>;
}

export interface QQKeyboardPayload {
  content: {
    rows: QQKeyboardRow[];
  };
}

export interface QQKeyboardRow {
  buttons: QQKeyboardButton[];
}

export interface QQKeyboardButton {
  action: {
    data: string;
    enter?: boolean;
    permission: {
      type: number;
    };
    reply?: boolean;
    type: number;
    unsupport_tips?: string;
  };
  id?: string;
  render_data: {
    label: string;
    style: number;
    visited_label: string;
  };
}

export interface QQArkObjectKeyValue {
  key: string;
  value: string;
}

export interface QQArkObject {
  obj_kv: QQArkObjectKeyValue[];
}

export interface QQArkKeyValue {
  key: string;
  obj?: QQArkObject[];
  value?: string;
}

export interface QQArkPayload {
  kv: QQArkKeyValue[];
  template_id: number;
}

export interface QQMediaPayload {
  file_info: string;
  file_uuid?: string;
  ttl?: number;
}

export interface QQMediaUploadRequest {
  file_data?: string;
  file_type: number;
  srv_send_msg: boolean;
  url?: string;
}

export interface QQMediaUploadResponse {
  file_info: string;
  file_uuid?: string;
  id?: string;
  ttl?: number;
}

/** Shared raw message shape used for inbound and outbound normalization. */
export interface QQBaseMessage {
  /** Internal flag set by adapter for locally posted messages. */
  _chat_is_outbound?: boolean;
  /** Internal normalized thread id storage value. */
  _chat_thread_id?: string;
  /** Internal normalized thread scene type. */
  _chat_thread_type?: QQThreadType;
  /** Normalized quoted/referenced QQ message data, derived from message_scene/msg_elements. */
  _chat_quoted_message?: QQQuotedMessage;
  /** File attachments. */
  attachments?: QQMessageAttachment[];
  /** Author metadata. */
  author?: QQMessageAuthor;
  /** Message text content. */
  content?: string;
  /** Edited timestamp. */
  edited_timestamp?: string;
  /** Passive reply context event id. */
  event_id?: string;
  /** Legacy/alternate group id field from QQ payloads. */
  group_id?: string;
  /** Group openid field from QQ payloads. */
  group_openid?: string;
  /** Primary message id. */
  id?: string;
  /** QQ msg_id field (also used for passive reply context). */
  msg_id?: string;
  /** QQ message elements, used by newer payloads for rich/message-reference data. */
  msg_elements?: QQMessageElement[];
  /** QQ message scene metadata, including msg_idx/ref_msg_idx values. */
  message_scene?: QQMessageScene;
  /** QQ message type code. */
  message_type?: number;
  /** User openid from QQ payloads. */
  openid?: string;
  /** Message timestamp. */
  timestamp?: string;
  /** User openid from non-message event payloads. */
  user_openid?: string;
}

export interface QQInteractionPayload {
  application_id?: string;
  chat_type?: number;
  data?: {
    resolved?: {
      button_data?: string;
      button_id?: string;
      message_id?: string;
      user_id?: string;
    };
    type?: number;
  };
  group_member_openid?: string;
  group_openid?: string;
  id?: string;
  message_id?: string;
  openid?: string;
  scene?: "c2c" | "group" | string;
  timestamp?: string;
  user_openid?: string;
  version?: number;
}

export interface QQThreadResolvableEventData {
  author?: QQMessageAuthor;
  event_id?: string;
  group_id?: string;
  group_openid?: string;
  id?: string;
  msg_id?: string;
  op_member_openid?: string;
  openid?: string;
  scene?: number;
  scene_param?: string;
  timestamp?: number | string;
  user_openid?: string;
}

export type QQPlatformEventType =
  | "C2C_MSG_REJECT"
  | "C2C_MSG_RECEIVE"
  | "FRIEND_ADD"
  | "FRIEND_DEL"
  | "GROUP_ADD_ROBOT"
  | "GROUP_DEL_ROBOT"
  | "GROUP_MSG_REJECT"
  | "GROUP_MSG_RECEIVE";

export interface QQMessageEventDataMap {
  C2C_MESSAGE_CREATE: QQIncomingMessage;
  GROUP_AT_MESSAGE_CREATE: QQIncomingMessage;
}

export interface QQActionEventDataMap {
  INTERACTION_CREATE: QQInteractionPayload;
}

export interface QQPlatformEventDataMap {
  C2C_MSG_REJECT: QQThreadResolvableEventData;
  C2C_MSG_RECEIVE: QQThreadResolvableEventData;
  FRIEND_ADD: QQThreadResolvableEventData;
  FRIEND_DEL: QQThreadResolvableEventData;
  GROUP_ADD_ROBOT: QQThreadResolvableEventData;
  GROUP_DEL_ROBOT: QQThreadResolvableEventData;
  GROUP_MSG_REJECT: QQThreadResolvableEventData;
  GROUP_MSG_RECEIVE: QQThreadResolvableEventData;
}

export type QQKnownDispatchEventType =
  | QQActionEventType
  | QQGatewayLifecycleEventType
  | QQMessageEventType
  | QQPlatformEventType;

export interface QQPlatformEvent<TType extends QQPlatformEventType = QQPlatformEventType> {
  data: QQPlatformEventDataMap[TType] | undefined;
  eventId: string;
  payload: QQWebhookPayload<QQPlatformEventDataMap[TType], TType>;
  threadId?: string;
  type: TType;
}

export type QQPlatformEventHandler<TType extends QQPlatformEventType = QQPlatformEventType> = (
  event: QQPlatformEvent<TType>,
) => Promise<void> | void;

/** Inbound message payload from webhook/OpenAPI. */
export interface QQIncomingMessage extends QQBaseMessage {}

/** Outbound/sent message payload from OpenAPI. */
export interface QQSentMessage extends QQBaseMessage {
}

/** Raw QQ message union used by adapter parse/send methods. */
export type QQRawMessage = QQIncomingMessage | QQSentMessage;

/** QQ OpenAPI send-message request body. */
export interface QQSendMessageRequest {
  /** QQ Ark message payload. */
  ark?: QQArkPayload;
  /** Outbound message content. */
  content?: string;
  /** Passive reply context field. */
  event_id?: string;
  /** QQ interactive keyboard payload. */
  keyboard?: QQKeyboardPayload;
  /** QQ markdown message payload. */
  markdown?: QQMarkdownPayload;
  /** QQ media message payload. */
  media?: QQMediaPayload;
  /** Passive reply context field. */
  msg_id?: string;
  /** Passive reply sequence in the same msg_id context. */
  msg_seq?: number;
  /** QQ msg type: 0=text. */
  msg_type: number;
}

/** QQ app access token response. */
export interface QQAccessTokenResponse {
  /** Bearer token used in `QQBot` authorization header. */
  access_token: string;
  /** Token TTL in seconds. */
  expires_in: number | string;
}

export interface QQGatewayBotResponse {
  session_start_limit?: {
    max_concurrency: number;
    remaining: number;
    reset_after: number;
    total: number;
  };
  shards?: number;
  url: string;
}

/** QQ stream message request body. */
export interface QQStreamMessageRequest {
  /** Update mode: always "replace". */
  input_mode: "replace";
  /** Stream state: 1=intermediate (generating), 10=final (done). */
  input_state: 1 | 10;
  /** Content format type. */
  content_type: "markdown";
  /** Current full message content (replace mode). */
  content_raw: string;
  /** Passive reply context event id. */
  event_id?: string;
  /** Passive reply context message id. */
  msg_id?: string;
  /** Passive reply sequence. */
  msg_seq?: number;
  /** Frame index in the stream, starting from 0. */
  index: number;
  /** Stream message ID returned from first call, required for subsequent calls. */
  stream_msg_id?: string;
}

/** QQ stream message response body. */
export interface QQStreamMessageResponse {
  /** Stream message ID. */
  id: string;
  /** Response timestamp. */
  timestamp?: string;
  /** Extended info including ref_idx. */
  ext_info?: { ref_idx: string };
  /** Remaining message length. */
  remain_msg_len?: number;
}
