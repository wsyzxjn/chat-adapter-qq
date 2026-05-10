import type {
  AdapterPostableMessage,
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
  return attachments.map((attachment) => ({
    fetchData: undefined,
    height: attachment.height,
    mimeType: attachment.content_type,
    name: attachment.filename,
    size: attachment.size,
    type: attachment.content_type?.startsWith("image/") ? "image" : "file",
    url: attachment.url,
    width: attachment.width,
  }));
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

  if ("attachments" in message && Array.isArray(message.attachments) && message.attachments.length > 0) {
    throw new NotImplementedError(
      "QQ adapter does not support outbound `attachments` in post payloads. Use text/card content only.",
      "attachments",
    );
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
