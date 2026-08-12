import type { QQArkData, QQIncomingMessage, QQMessageAttachment, QQMessageElement } from "../types.js";

function isNonEmptyText(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

function stringField(fields: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = fields?.[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** Render useful Chat-facing text from inbound ARK card metadata. */
export function formatArkData(ark: QQArkData | undefined): string {
  if (!ark) {
    return "";
  }

  const lines: string[] = [];
  const heading = ark.ark_name?.trim() || ark.ark_type?.trim();
  if (heading) {
    lines.push(`[${heading}]`);
  }

  const prompt = ark.prompt?.trim();
  const title = stringField(ark.fields, "title");
  const desc = stringField(ark.fields, "desc");
  if (prompt) {
    lines.push(prompt);
  } else {
    if (title) {
      lines.push(title);
    }
    if (desc && desc !== title) {
      lines.push(desc);
    }
  }

  const source = stringField(ark.fields, "source");
  if (source) {
    lines.push(source);
  }
  const jumpUrl = stringField(ark.fields, "jump_url");
  if (jumpUrl) {
    lines.push(jumpUrl);
  }

  return lines.join("\n").trim();
}

function firstAsrText(attachments: readonly QQMessageAttachment[] | undefined): string {
  for (const attachment of attachments ?? []) {
    if (isNonEmptyText(attachment.asr_refer_text)) {
      return attachment.asr_refer_text.trim();
    }
  }
  return "";
}

function collectElementText(elements: readonly QQMessageElement[] | undefined): string {
  if (!elements?.length) {
    return "";
  }

  const parts: string[] = [];
  for (const element of elements) {
    if (isNonEmptyText(element.content)) {
      parts.push(element.content.trim());
    }
    const arkText = formatArkData(element.ark_data);
    if (arkText) {
      parts.push(arkText);
    }
    const asrText = firstAsrText(element.attachments);
    if (asrText) {
      parts.push(asrText);
    }
    const nested = collectElementText(element.msg_elements);
    if (nested) {
      parts.push(nested);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Resolve Chat-facing text for an inbound QQ message.
 *
 * Prefer `content` when it already has useful text. Otherwise fall back to
 * voice ASR, ARK card metadata, then nested `msg_elements` (101/102/103).
 * Full platform payloads stay on `raw`.
 */
export function resolveInboundDisplayText(raw: QQIncomingMessage): string {
  if (isNonEmptyText(raw.content)) {
    return raw.content;
  }

  const asrText = firstAsrText(raw.attachments);
  if (asrText) {
    return asrText;
  }

  const arkText = formatArkData(raw.ark_data);
  if (arkText) {
    return arkText;
  }

  return collectElementText(raw.msg_elements);
}
