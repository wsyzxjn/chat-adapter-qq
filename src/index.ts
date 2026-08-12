export { QQAdapter } from "./adapter.js";
export {
  BOT_API_BASE_URL,
  BOT_TOKEN_ENDPOINT,
  DEFAULT_API_BASE_URL,
  DEFAULT_CHUNKED_UPLOAD_THRESHOLD_BYTES,
  DEFAULT_GATEWAY_INTENTS,
  DEFAULT_TOKEN_ENDPOINT,
  QQ_INTENTS,
  SANDBOX_API_BASE_URL,
} from "./constants.js";
export { QQFormatConverter } from "./format-converter.js";
export { isQQMentioned } from "./mentions.js";
export type {
  QQAccessTokenResponse,
  QQAdapterBaseConfig,
  QQAdapterConfig,
  QQAdapterMode,
  QQApiHost,
  QQActionEventDataMap,
  QQActionEventType,
  QQArkData,
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
  QQMessageAuditEventData,
  QQMessageEventType,
  QQMessageMention,
  QQMessageReference,
  QQMediaPayload,
  QQMediaUploadRequest,
  QQMediaUploadResponse,
  QQUploadConfig,
  QQUploadPart,
  QQUploadPartFinishRequest,
  QQUploadPrepareRequest,
  QQUploadPrepareResponse,
  QQPlatformEvent,
  QQPlatformEventDataMap,
  QQPlatformEventHandler,
  QQPlatformEventType,
  QQRawMessage,
  QQSendMessageRequest,
  QQSendMessageOptions,
  QQSentMessage,
  QQSocketModeAdapterConfig,
  QQSocketModeMessageData,
  QQSocketModeOptions,
  QQSocketModeWebSocket,
  QQSocketModeWebSocketFactory,
  QQStreamMessageRequest,
  QQStreamMessageResponse,
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
