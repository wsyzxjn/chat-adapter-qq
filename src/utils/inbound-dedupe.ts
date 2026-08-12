import type { QQIncomingMessage } from "../types.js";
import { findMessageSceneValue } from "./message-scene.js";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeMsgSeq(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

/**
 * Stable identity for inbound QQ message events.
 *
 * Official docs say the same `msg_id` may be redelivered; developers should
 * dedupe with `msg_seq` and/or `message_scene.ext` `msg_idx`. Event payloads
 * commonly expose `id`/`msg_id` plus `msg_idx`; `msg_seq` is included when
 * present.
 */
export function buildInboundMessageDedupeKey(
  raw: QQIncomingMessage,
  threadId: string,
): string | null {
  const messageId = firstNonEmpty(raw.id, raw.msg_id);
  const msgIdx = findMessageSceneValue(raw.message_scene?.ext, "msg_idx");
  const msgSeq = normalizeMsgSeq(raw.msg_seq);
  if (!messageId && !msgIdx) {
    return null;
  }
  return `${threadId}\0${messageId ?? ""}\0${msgIdx ?? ""}\0${msgSeq ?? ""}`;
}
