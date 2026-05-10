import type {
  AdapterPostableMessage,
  Attachment,
  CardElement,
  Message,
  PostableAst,
  PostableCard,
  PostableMarkdown,
  PostableRaw,
  StreamChunk,
} from "chat";
import { ChatError, NotImplementedError, isCardElement } from "chat";
import { QQFormatConverter } from "../format-converter.js";
import type {
  QQKeyboardButton,
  QQKeyboardPayload,
  QQMessageAttachment,
  QQRawMessage,
  QQSendMessageRequest,
  QQThreadId,
} from "../types.js";
import { assertNever } from "./assert.js";
import { buildOutboundContent } from "./content.js";

export function toAttachments(
  attachments: QQMessageAttachment[] | undefined,
): Message<QQRawMessage>["attachments"] {
  if (!attachments?.length) {
    return [];
  }
  return attachments.map((attachment) => {
    const output: Attachment = {
      type: attachment.content_type?.startsWith("image/") ? "image" : "file",
    };
    if (attachment.height !== undefined) {
      output.height = attachment.height;
    }
    if (attachment.content_type !== undefined) {
      output.mimeType = attachment.content_type;
    }
    if (attachment.filename !== undefined) {
      output.name = attachment.filename;
    }
    if (attachment.size !== undefined) {
      output.size = attachment.size;
    }
    if (attachment.url !== undefined) {
      output.url = attachment.url;
    }
    if (attachment.width !== undefined) {
      output.width = attachment.width;
    }
    return output;
  });
}

export function buildMessageContentPayload(
  converter: QQFormatConverter,
  message: AdapterPostableMessage,
): QQSendMessageRequest {
  if (typeof message === "string" || isPostableRaw(message)) {
    return {
      content: buildOutboundContent(converter, message),
      msg_type: 0,
    };
  }

  if (isPostableMarkdown(message) || isPostableAst(message)) {
    return {
      markdown: {
        content: buildOutboundContent(converter, message),
      },
      msg_type: 2,
    };
  }

  const card = extractCard(message);
  if (card) {
    const payload: QQSendMessageRequest = {
      markdown: {
        content: buildOutboundContent(converter, message),
      },
      msg_type: 2,
    };
    const keyboard = cardToKeyboard(card);
    if (keyboard) {
      payload.keyboard = keyboard;
    }
    return payload;
  }

  return {
    content: buildOutboundContent(converter, message),
    msg_type: 0,
  };
}

export function getPostMessagePath(thread: QQThreadId): string {
  switch (thread.type) {
    case "group":
      return `/v2/groups/${encodeURIComponent(thread.groupOpenId)}/messages`;
    case "c2c":
      return `/v2/users/${encodeURIComponent(thread.userOpenId)}/messages`;
    case "guild_channel":
      throw new NotImplementedError("Guild channel postMessage is not implemented yet.", "postMessage");
    default:
      return assertNever(thread);
  }
}

export function getUploadMediaPath(thread: QQThreadId): string {
  switch (thread.type) {
    case "group":
      return `/v2/groups/${encodeURIComponent(thread.groupOpenId)}/files`;
    case "c2c":
      return `/v2/users/${encodeURIComponent(thread.userOpenId)}/files`;
    case "guild_channel":
      throw new NotImplementedError("Guild channel media upload is not implemented yet.", "files");
    default:
      return assertNever(thread);
  }
}

export function getDeleteMessagePath(thread: QQThreadId, messageId: string): string {
  switch (thread.type) {
    case "group":
      return `/v2/groups/${encodeURIComponent(thread.groupOpenId)}/messages/${encodeURIComponent(messageId)}`;
    case "c2c":
      return `/v2/users/${encodeURIComponent(thread.userOpenId)}/messages/${encodeURIComponent(messageId)}`;
    case "guild_channel":
      throw new NotImplementedError("Guild channel deleteMessage is not implemented yet.", "deleteMessage");
    default:
      return assertNever(thread);
  }
}

export function streamChunkToText(chunk: string | StreamChunk): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  switch (chunk.type) {
    case "markdown_text":
      return chunk.text;
    case "task_update":
      return [
        `- ${chunk.title}: ${chunk.status}`,
        chunk.details,
        chunk.output,
      ].filter(Boolean).join("\n");
    case "plan_update":
      return chunk.title;
    default:
      return assertNever(chunk);
  }
}

export function validateMessagePayload(message: AdapterPostableMessage): void {
  if (typeof message === "string") {
    return;
  }

  if ("files" in message && Array.isArray(message.files) && message.files.length > 0) {
    throw new NotImplementedError(
      "QQ API v2 user/group messaging currently accepts URL-based media workflows. Direct file upload is not implemented in this adapter.",
      "files",
    );
  }

  const attachments = getPostableAttachments(message);
  if (attachments.length > 1 && attachments.some((attachment) => attachment.type !== "image")) {
    throw new NotImplementedError("QQ adapter supports multiple outbound attachments only for images.", "attachments");
  }
  if (attachments.some((attachment) => !hasAttachmentSource(attachment))) {
    throw new NotImplementedError(
      "QQ media messages require URL-based or binary attachment data.",
      "attachments",
    );
  }
}

export function hasAttachmentSource(attachment: Attachment): boolean {
  return Boolean(attachment.url || attachment.data || attachment.fetchData);
}

export function getPostableAttachments(message: AdapterPostableMessage): Attachment[] {
  if (typeof message === "string") {
    return [];
  }
  return "attachments" in message && Array.isArray(message.attachments) ? message.attachments : [];
}

export function toQQMediaFileType(thread: QQThreadId, attachment: Attachment): number {
  switch (attachment.type) {
    case "image":
      return 1;
    case "video":
      return 2;
    case "audio":
      return 3;
    case "file":
      if (thread.type === "group") {
        throw new NotImplementedError("QQ group media messages do not support file attachments yet.", "attachments");
      }
      return 4;
    default:
      return assertNever(attachment.type);
  }
}

function isPostableRaw(message: AdapterPostableMessage): message is PostableRaw {
  return isRecord(message) && typeof message.raw === "string";
}

function isPostableMarkdown(message: AdapterPostableMessage): message is PostableMarkdown {
  return isRecord(message) && typeof message.markdown === "string";
}

function isPostableAst(message: AdapterPostableMessage): message is PostableAst {
  return isRecord(message) && isRecord(message.ast);
}

function isPostableCard(message: AdapterPostableMessage): message is PostableCard {
  return isRecord(message) && isCardElement(message.card);
}

function extractCard(message: AdapterPostableMessage): CardElement | null {
  if (isCardElement(message)) {
    return message;
  }
  if (isPostableCard(message)) {
    return message.card;
  }
  return null;
}

function cardToKeyboard(card: CardElement): QQKeyboardPayload | null {
  const buttons = extractKeyboardButtons(card);
  if (buttons.length === 0) {
    return null;
  }
  if (buttons.length > 25) {
    throw new ChatError("QQ keyboards support at most 25 buttons.", "INVALID_REQUEST");
  }

  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({
      buttons: buttons.slice(index, index + 5),
    });
  }

  return {
    content: {
      rows,
    },
  };
}

function extractKeyboardButtons(card: CardElement): QQKeyboardButton[] {
  const output: QQKeyboardButton[] = [];
  const visit = (children: CardElement["children"]): void => {
    for (const child of children) {
      if (child.type === "section") {
        visit(child.children);
        continue;
      }

      if (child.type !== "actions") {
        continue;
      }

      for (const action of child.children) {
        if (action.type === "button") {
          output.push(toQQCallbackButton(action.label, action.id, action.value ?? action.id, action.style));
          continue;
        }
        if (action.type === "link-button") {
          output.push(toQQLinkButton(action.label, action.url, action.style));
          continue;
        }

        throw new NotImplementedError(`QQ keyboard does not support ${action.type} actions yet.`, action.type);
      }
    }
  };

  visit(card.children);
  return output;
}

function toQQCallbackButton(
  label: string,
  actionId: string,
  value: string,
  style: QQKeyboardButton["render_data"]["style"] | "primary" | "danger" | "default" | undefined,
): QQKeyboardButton {
  return {
    action: {
      data: value || actionId,
      permission: {
        type: 2,
      },
      type: 1,
      unsupport_tips: label,
    },
    id: actionId,
    render_data: {
      label,
      style: toQQButtonStyle(style),
      visited_label: label,
    },
  };
}

function toQQLinkButton(
  label: string,
  url: string,
  style: QQKeyboardButton["render_data"]["style"] | "primary" | "danger" | "default" | undefined,
): QQKeyboardButton {
  return {
    action: {
      data: url,
      permission: {
        type: 2,
      },
      type: 0,
    },
    render_data: {
      label,
      style: toQQButtonStyle(style),
      visited_label: label,
    },
  };
}

function toQQButtonStyle(style: QQKeyboardButton["render_data"]["style"] | "primary" | "danger" | "default" | undefined): number {
  if (style === "primary") {
    return 1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
