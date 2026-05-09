import type { QQThreadType } from "./types.js";

/** Webhook callback dispatch opcode. */
export const CALLBACK_DISPATCH_OPCODE = 0;
/** Webhook callback ACK opcode. */
export const CALLBACK_ACK_OPCODE = 12;
/** Webhook callback validation opcode. */
export const CALLBACK_VALIDATION_OPCODE = 13;

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

/** QQ webhook signature header. */
export const SIGNATURE_HEADER = "X-Signature-Ed25519";
/** QQ webhook signature timestamp header. */
export const SIGNATURE_TIMESTAMP_HEADER = "X-Signature-Timestamp";
/** QQ webhook app id header. */
export const APP_ID_HEADER = "X-Bot-Appid";

/** QQ webhook event types treated as inbound message events. */
export const MESSAGE_EVENT_TYPES = new Set([
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
]);

/** QQ webhook event types treated as Chat SDK action events. */
export const ACTION_EVENT_TYPES = new Set([
  "INTERACTION_CREATE",
]);

/** QQ non-message dispatch events known by this adapter's current C2C/GROUP scope. */
export const PLATFORM_EVENT_TYPES = new Set([
  "C2C_MSG_RECEIVE",
  "FRIEND_ADD",
  "FRIEND_DEL",
  "GROUP_ADD_ROBOT",
  "GROUP_DEL_ROBOT",
  "GROUP_MSG_RECEIVE",
  "GROUP_REJECT_ADD_ROBOT",
]);

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
