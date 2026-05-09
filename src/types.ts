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

/** QQ adapter runtime configuration. */
export interface QQAdapterConfig {
  /** Advanced: whether to send QQ interaction ACK API calls for button events. Defaults to true. */
  acknowledgeInteractions?: boolean;
  /** Advanced/test: override QQ OpenAPI base URL. */
  apiBaseUrl?: string;
  /** QQ bot app id. */
  appId: string;
  /** Advanced: Bot Secret used for webhook signing; falls back to clientSecret. */
  botSecret?: string;
  /** Optional Chat SDK identity hint to improve `isMe` detection. */
  botUserId?: string;
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

/** Generic QQ webhook envelope. */
export interface QQWebhookPayload<TData = unknown> {
  /** Event data payload. */
  d?: TData;
  /** Callback event id. */
  id: string;
  /** Callback opcode. */
  op: number;
  /** Sequence number for callback ACK. */
  s?: number;
  /** Event type string, e.g. `GROUP_AT_MESSAGE_CREATE`. */
  t?: string;
}

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
  /** Media width for image-like attachment. */
  width?: number;
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

/** Shared raw message shape used for inbound and outbound normalization. */
export interface QQBaseMessage {
  /** Internal flag set by adapter for locally posted messages. */
  _chat_is_outbound?: boolean;
  /** Internal normalized thread id storage value. */
  _chat_thread_id?: string;
  /** Internal normalized thread scene type. */
  _chat_thread_type?: QQThreadType;
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

export type QQPlatformEventType =
  | "C2C_MSG_RECEIVE"
  | "FRIEND_ADD"
  | "FRIEND_DEL"
  | "GROUP_ADD_ROBOT"
  | "GROUP_DEL_ROBOT"
  | "GROUP_MSG_RECEIVE"
  | "GROUP_REJECT_ADD_ROBOT";

export interface QQPlatformEvent<TData = unknown, TType extends QQPlatformEventType = QQPlatformEventType> {
  data: TData;
  eventId: string;
  payload: QQWebhookPayload<TData>;
  threadId?: string;
  type: TType;
}

export type QQPlatformEventHandler<TType extends QQPlatformEventType = QQPlatformEventType> = (
  event: QQPlatformEvent<unknown, TType>,
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
  /** Outbound message content. */
  content?: string;
  /** Passive reply context field. */
  event_id?: string;
  /** QQ interactive keyboard payload. */
  keyboard?: QQKeyboardPayload;
  /** QQ markdown message payload. */
  markdown?: QQMarkdownPayload;
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
