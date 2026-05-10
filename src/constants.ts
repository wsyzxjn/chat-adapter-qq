import type {
  QQActionEventType,
  QQMessageEventType,
  QQPlatformEventType,
  QQThreadType,
} from "./types.js";

/** Webhook callback dispatch opcode. */
export const CALLBACK_DISPATCH_OPCODE = 0;
/** Webhook callback ACK opcode. */
export const CALLBACK_ACK_OPCODE = 12;
/** Webhook callback validation opcode. */
export const CALLBACK_VALIDATION_OPCODE = 13;

/** Gateway heartbeat opcode. */
export const GATEWAY_HEARTBEAT_OPCODE = 1;
/** Gateway identify opcode. */
export const GATEWAY_IDENTIFY_OPCODE = 2;
/** Gateway resume opcode. */
export const GATEWAY_RESUME_OPCODE = 6;
/** Gateway reconnect opcode. */
export const GATEWAY_RECONNECT_OPCODE = 7;
/** Gateway invalid-session opcode. */
export const GATEWAY_INVALID_SESSION_OPCODE = 9;
/** Gateway hello opcode. */
export const GATEWAY_HELLO_OPCODE = 10;
/** Gateway heartbeat ACK opcode. */
export const GATEWAY_HEARTBEAT_ACK_OPCODE = 11;

/** QQ OpenAPI base URL (production). */
export const DEFAULT_API_BASE_URL = "https://api.sgroup.qq.com";
/** QQ OpenAPI base URL (sandbox). */
export const SANDBOX_API_BASE_URL = "https://sandbox.api.sgroup.qq.com";
/** QQ app access token endpoint. */
export const DEFAULT_TOKEN_ENDPOINT = "https://bots.qq.com/app/getAppAccessToken";
/** Default message pagination limit for in-memory cache reads. */
export const DEFAULT_FETCH_LIMIT = 50;
/** Per-thread in-memory message cache cap. */
export const MAX_CACHE_MESSAGES_PER_THREAD = 200;

/** QQ gateway event intent bit values. */
export const QQ_INTENTS = {
  AUDIO_ACTION: 1 << 29,
  DIRECT_MESSAGE: 1 << 12,
  FORUMS_EVENT: 1 << 28,
  GROUP_AND_C2C_EVENT: 1 << 25,
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

/** Default gateway intents for this adapter's current C2C/GROUP scope. */
export const DEFAULT_GATEWAY_INTENTS = QQ_INTENTS.GROUP_AND_C2C_EVENT | QQ_INTENTS.INTERACTION;

/** QQ webhook signature header. */
export const SIGNATURE_HEADER = "X-Signature-Ed25519";
/** QQ webhook signature timestamp header. */
export const SIGNATURE_TIMESTAMP_HEADER = "X-Signature-Timestamp";
/** QQ webhook app id header. */
export const APP_ID_HEADER = "X-Bot-Appid";

/** QQ webhook event types treated as inbound message events. */
export const MESSAGE_EVENT_TYPES = [
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
] as const satisfies readonly QQMessageEventType[];
const MESSAGE_EVENT_TYPE_SET: ReadonlySet<string> = new Set(MESSAGE_EVENT_TYPES);

/** QQ webhook event types treated as Chat SDK action events. */
export const ACTION_EVENT_TYPES = [
  "INTERACTION_CREATE",
] as const satisfies readonly QQActionEventType[];
const ACTION_EVENT_TYPE_SET: ReadonlySet<string> = new Set(ACTION_EVENT_TYPES);

/** QQ non-message dispatch events known by this adapter's current C2C/GROUP scope. */
export const PLATFORM_EVENT_TYPES = [
  "C2C_MSG_REJECT",
  "C2C_MSG_RECEIVE",
  "FRIEND_ADD",
  "FRIEND_DEL",
  "GROUP_ADD_ROBOT",
  "GROUP_DEL_ROBOT",
  "GROUP_MSG_REJECT",
  "GROUP_MSG_RECEIVE",
] as const satisfies readonly QQPlatformEventType[];
const PLATFORM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PLATFORM_EVENT_TYPES);

export function isQQActionEventType(type: string | undefined): type is QQActionEventType {
  return typeof type === "string" && ACTION_EVENT_TYPE_SET.has(type);
}

export function isQQMessageEventType(type: string | undefined): type is QQMessageEventType {
  return typeof type === "string" && MESSAGE_EVENT_TYPE_SET.has(type);
}

export function isQQPlatformEventType(type: string | undefined): type is QQPlatformEventType {
  return typeof type === "string" && PLATFORM_EVENT_TYPE_SET.has(type);
}

export type QQFeature = "addReaction" | "deleteMessage" | "editMessage" | "postMessage" | "removeReaction";
/**
 * Feature availability matrix by QQ scene type.
 *
 * Used by adapter runtime guards (`assertFeature`) to fail fast with
 * `NotImplementedError` for unsupported scene + feature combinations.
 */
export const FEATURE_SUPPORT: Record<QQFeature, ReadonlySet<QQThreadType>> = {
  addReaction: new Set(),
  deleteMessage: new Set<QQThreadType>(["c2c", "group"]),
  editMessage: new Set(),
  postMessage: new Set<QQThreadType>(["c2c", "group"]),
  removeReaction: new Set(),
};
