export { QQAdapter } from "./adapter.js";
export { QQ_INTENTS } from "./constants.js";
export { QQFormatConverter } from "./format-converter.js";
export type {
  QQAccessTokenResponse,
  QQAdapterConfig,
  QQAdapterMode,
  QQGatewayBotResponse,
  QQIncomingMessage,
  QQMessageAttachment,
  QQPlatformEvent,
  QQPlatformEventHandler,
  QQPlatformEventType,
  QQRawMessage,
  QQSendMessageRequest,
  QQSentMessage,
  QQSocketModeOptions,
  QQSocketModeWebSocket,
  QQSocketModeWebSocketFactory,
  QQThreadId,
  QQThreadType,
  QQWebhookPayload,
  QQWebhookValidationData,
} from "./types.js";

import type { QQAdapterConfig } from "./types.js";
import { QQAdapter } from "./adapter.js";

/**
 * Create a QQ adapter instance for Chat SDK.
 *
 * @param config QQ adapter runtime configuration.
 */
export function createQQAdapter(config: QQAdapterConfig): QQAdapter {
  return new QQAdapter(config);
}
