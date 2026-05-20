function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveRaw(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if ("_chat_is_mention" in value) {
    return value;
  }
  return value.raw;
}

/** Return whether a QQ raw payload or Chat SDK event/message mentions the current bot. */
export function isQQMentioned(value: unknown): boolean {
  const raw = resolveRaw(value);
  return isRecord(raw) && raw._chat_is_mention === true;
}
