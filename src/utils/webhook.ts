import type { QQWebhookValidationData } from "../types.js";

/** Runtime shape check for QQ webhook validation payload (`op=13`). */
export function isValidationPayload(data: unknown): data is QQWebhookValidationData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const payload = data as QQWebhookValidationData;
  return typeof payload.event_ts === "string" && typeof payload.plain_token === "string";
}
