export { QQAdapter } from "./adapter.js";
export { QQ_INTENTS } from "./constants.js";
export { QQFormatConverter } from "./format-converter.js";
export type {
  QQAccessTokenResponse,
  QQAdapterBaseConfig,
  QQAdapterConfig,
  QQAdapterMode,
  QQActionEventDataMap,
  QQActionEventType,
  QQArkKeyValue,
  QQArkObject,
  QQArkObjectKeyValue,
  QQArkPayload,
  QQGatewayBotResponse,
  QQGatewayLifecycleEventType,
  QQIncomingMessage,
  QQKnownDispatchEventType,
  QQMessageEventDataMap,
  QQMessageAttachment,
  QQMessageEventType,
  QQMediaPayload,
  QQMediaUploadRequest,
  QQMediaUploadResponse,
  QQPlatformEvent,
  QQPlatformEventDataMap,
  QQPlatformEventHandler,
  QQPlatformEventType,
  QQRawMessage,
  QQSendMessageRequest,
  QQSentMessage,
  QQSocketModeAdapterConfig,
  QQSocketModeMessageData,
  QQSocketModeOptions,
  QQSocketModeWebSocket,
  QQSocketModeWebSocketFactory,
  QQThreadResolvableEventData,
  QQThreadId,
  QQThreadType,
  QQWebhookAdapterConfig,
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
