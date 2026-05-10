import type { AdapterPostableMessage } from "chat";
import { QQFormatConverter } from "../format-converter.js";

const EMPTY_MESSAGE_CONTENT = " ";

/**
 * Render Chat SDK postable message into QQ outbound text payload.
 *
 * QQ rejects empty content, so whitespace fallback is used when rendered text
 * is blank.
 */
export function buildOutboundContent(converter: QQFormatConverter, message: AdapterPostableMessage): string {
  const rendered = converter.renderPostable(message).trim();
  return rendered.length > 0 ? rendered : EMPTY_MESSAGE_CONTENT;
}
