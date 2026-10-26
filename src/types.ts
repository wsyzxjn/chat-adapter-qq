import type { Logger } from "chat";

/** QQ private chat thread identifier (`/v2/users/{openid}`). */
export interface QQC2CThreadId {
  /** Scene discriminator. */
  type: "c2c";
  /** User openid in QQ C2C scene. */
  userOpenId: string;
}

/** QQ group chat thread identifier (`/v2/groups/{group_openid}`). */
export interface QQGroupThreadId {
  /** Scene discriminator. */
  type: "group";
  /** Group openid in QQ group scene. */
  groupOpenId: string;
}

/** QQ guild channel thread identifier (reserved for channel scene expansion). */
export interface QQGuildChannelThreadId {
  /** Scene discriminator. */
  type: "guild_channel";
  /** Channel id inside the guild. */
  channelId: string;
  /** Guild id that owns the channel. */
  guildId: string;
}

/** Discriminated union for supported QQ thread scenes. */
export type QQThreadId =
  | QQC2CThreadId
  | QQGroupThreadId
  | QQGuildChannelThreadId;

/** Convenience union of QQ scene type literals. */
export type QQThreadType = QQThreadId["type"];

/** Runtime transport mode used for receiving QQ events. */
export type QQAdapterMode = "socket" | "webhook";

export type QQSocketModeMessageData = ArrayBuffer | string;

export interface QQSocketModeWebSocket {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<QQSocketModeMessageData>) => void,
  ): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(
    type: "error" | "open",
    listener: (event: Event) => void,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type QQSocketModeWebSocketFactory = (
  url: string,
) => QQSocketModeWebSocket;

export interface QQSocketModeOptions {
  /** Automatically start every recommended gateway shard. Defaults to true unless `shard` is set. */
  autoSharding?: boolean;
  /** Gateway identify properties. Defaults to this package name. */
  properties?: Record<string, string>;
  /** Automatically reconnect after gateway close/reconnect requests. Defaults to true. */
  reconnect?: boolean;
  /** Delay before reconnecting in milliseconds. Defaults to 1000. */
  reconnectDelayMs?: number;
  /** Maximum exponential reconnect delay in milliseconds. Defaults to 30000. */
  maxReconnectDelayMs?: number;
  /** Whether to attempt opcode 6 resume when a session id is available. Defaults to true. */
  resume?: boolean;
  /** Gateway shard tuple. Defaults to [0, 1]. */
  shard?: readonly [number, number];
  /** Explicit WSS URL. When omitted, the adapter calls /gateway/bot. */
  url?: string;
  /** Advanced/test: custom WebSocket factory. Defaults to globalThis.WebSocket. */
  webSocketFactory?: QQSocketModeWebSocketFactory;
  /** Gateway event intents. Defaults to GROUP_AND_C2C_EVENT | INTERACTION. */
  intents?: number;
}

/** QQ adapter runtime configuration. */
export interface QQAdapterBaseConfig {
  /** Advanced: whether to send QQ interaction ACK API calls for button events. Defaults to true. */
  acknowledgeInteractions?: boolean;
  /** Advanced/test: override QQ OpenAPI base URL. */
  apiBaseUrl?: string;
  /** QQ bot app id. */
  appId: string;
  /** Advanced: Bot Secret used for webhook signing; falls back to clientSecret. */
  botSecret?: string;
  /** QQ bot client secret for access token retrieval. */
  clientSecret: string;
  /** Logger implementation from Chat SDK. */
  logger?: Logger;
  /** Advanced security option: whether webhook requests must include and match `X-Bot-Appid`. */
  requireAppIdHeader?: boolean;
  /** HTTP request timeout in milliseconds. */
  requestTimeoutMs?: number;
  /** Advanced/test: use QQ sandbox OpenAPI domain when true. */
  sandbox?: boolean;
  /** Return 400 for unsupported webhook events instead of ACK. */
  strictWebhookEvents?: boolean;
  /** Advanced/test: override token endpoint for custom environments. */
  tokenEndpoint?: string;
  /** Chat SDK bot username fallback when QQ author payload is incomplete. */
  userName?: string;
  /** Enable Ed25519 webhook signature verification. */
  verifySignature?: boolean;
  /** Allowed webhook timestamp skew in seconds. */
  webhookReplayWindowSec?: number;
}

export interface QQWebhookAdapterConfig extends QQAdapterBaseConfig {
  /** Event receiving mode. Defaults to webhook. */
  mode?: "webhook";
  /** Socket Mode options are only used when mode is socket. */
  socketMode?: never;
}

export interface QQSocketModeAdapterConfig extends QQAdapterBaseConfig {
  /** Start QQ Socket Mode during Chat initialization. */
  mode: "socket";
  /** Socket Mode connection options. */
  socketMode?: QQSocketModeOptions;
}

/** QQ adapter runtime configuration. */
export type QQAdapterConfig =
  | QQSocketModeAdapterConfig
  | QQWebhookAdapterConfig;

/** Generic QQ webhook/gateway envelope. */
export interface QQWebhookPayload<
  TData = unknown,
  TType extends string = string,
> {
  /** Event data payload. */
  d?: TData;
  /** Callback event id. */
  id?: string;
  /** Callback opcode. */
  op: number;
  /** Sequence number for callback ACK. */
  s?: number;
  /** Event type string, e.g. `GROUP_AT_MESSAGE_CREATE`. */
  t?: TType;
}

/** QQ dispatch event types treated as inbound messages by Chat SDK. */
export type QQMessageEventType =
  | "C2C_MESSAGE_CREATE"
  | "GROUP_AT_MESSAGE_CREATE"
  | "GROUP_MESSAGE_CREATE";

/** QQ dispatch event types treated as Chat SDK actions. */
export type QQActionEventType = "INTERACTION_CREATE";

/** QQ gateway lifecycle dispatch events. */
export type QQGatewayLifecycleEventType = "READY" | "RESUMED";

/** QQ webhook validation payload (`op=13`). */
export interface QQWebhookValidationData {
  /** QQ event timestamp string. */
  event_ts: string;
  /** Plain token used to compute validation signature. */
  plain_token: string;
}

/** QQ message author object from webhook/OpenAPI payload. */
export interface QQMessageAuthor {
  /** Avatar URL. */
  avatar?: string;
  /** Whether the author is a bot account. */
  bot?: boolean;
  /** Generic author id (guild-like scenes). */
  id?: string;
  /** Member openid in group scene. */
  member_openid?: string;
  /** Display nickname. */
  nick?: string;
  /** User openid in c2c scene. */
  user_openid?: string;
  /** Cross-application union openid when returned by QQ. */
  union_openid?: string;
  /** Cross-application user account when returned by QQ. */
  union_user_account?: string;
  /** Member role in the group. */
  member_role?: "member" | "admin" | "owner";
  /** Username/handle. */
  username?: string;
}

/** QQ attachment payload shape. */
export interface QQMessageAttachment {
  /** MIME type. */
  content_type?: string;
  /** File name. */
  filename?: string;
  /** Media height for image-like attachment. */
  height?: number;
  /** File size in bytes. */
  size?: number;
  /** Download URL. */
  url?: string;
  /** Voice file URL in WAV format (voice only). */
  voice_wav_url?: string;
  /** Voice ASR reference text (voice only). */
  asr_refer_text?: string;
  /** Media width for image-like attachment. */
  width?: number;
}

/** QQ mention payload from group message events. */
export interface QQMessageMention extends QQMessageAuthor {
  /** Display nickname for the mentioned user. */
  nickname?: string;
  /** Mention scope. */
  scope?: "all" | "single" | string;
  /** Whether this mention targets the current bot. */
  is_you?: boolean;
}

export interface QQMessageElement {
  [key: string]: unknown;
  content?: string;
  attachments?: QQMessageAttachment[];
  author?: QQMessageAuthor;
  ark_data?: QQArkData;
  msg_elements?: QQMessageElement[];
  message_type?: number;
  msg_idx?: string;
  type?: string;
}

/** Structured inbound card; distinct from the outbound ARK template payload. */
export interface QQArkData {
  ark_type?: "tuwen" | "feed" | "miniapp" | "map" | "contact_card" | "video_share" | "music_together" | "picture";
  ark_name?: string;
  prompt?: string;
  fields?: Record<string, unknown>;
}

export interface QQMessageScene {
  ext?: string[];
  source?: string;
}

export interface QQQuotedMessage {
  content?: string;
  messageType?: number;
  msgIdx: string;
}

export interface QQMarkdownPayload {
  content?: string;
  force_verify_image_resource?: boolean;
  custom_template_id?: string;
  params?: Array<{
    key: string;
    values: string[];
  }>;
}

export interface QQKeyboardPayload {
  content: {
    rows: QQKeyboardRow[];
  };
}

export interface QQKeyboardRow {
  buttons: QQKeyboardButton[];
}

export interface QQKeyboardButton {
  action: {
    data: string;
    enter?: boolean;
    permission: {
      type: number;
    };
    reply?: boolean;
    type: number;
    unsupport_tips?: string;
  };
  id?: string;
  render_data: {
    label: string;
    style: number;
    visited_label: string;
  };
}

export interface QQArkObjectKeyValue {
  key: string;
  value: string;
}

export interface QQArkObject {
  obj_kv: QQArkObjectKeyValue[];
}

export interface QQArkKeyValue {
  key: string;
  obj?: QQArkObject[];
  value?: string;
}

export interface QQArkPayload {
  kv: QQArkKeyValue[];
  template_id: number;
}

export interface QQMediaPayload {
  file_info: string;
  file_uuid?: string;
  ttl?: number;
}

export interface QQMediaUploadRequest {
  file_data?: string;
  /** Required for binary and multipart uploads. */
  file_name?: string;
  file_type: number;
  srv_send_msg: boolean;
  /** Upload task returned by upload_prepare for the multipart merge request. */
  upload_id?: string;
  url?: string;
}

export interface QQMediaUploadResponse {
  file_info: string;
  file_uuid?: string;
  id?: string;
  ttl?: number;
  raw_url?: string;
}

/** Shared raw message shape used for inbound and outbound normalization. */
export interface QQBaseMessage {
  /** QQ async-acceptance business code for messages awaiting audit/delivery. */
  _chat_async_code?: number;
  /** QQ async-acceptance description. */
  _chat_async_message?: string;
  /** Delivery state known at the time the raw message was created. */
  _chat_delivery_status?: "accepted" | "delivered" | "rejected";
  /** Original QQ dispatch event type for normalized inbound messages. */
  _chat_event_type?: QQMessageEventType;
  /** Internal flag set by adapter for locally posted messages. */
  _chat_is_outbound?: boolean;
  /** Whether this inbound message mentioned the current bot. */
  _chat_is_mention?: boolean;
  /** Internal normalized thread id storage value. */
  _chat_thread_id?: string;
  /** Internal normalized thread scene type. */
  _chat_thread_type?: QQThreadType;
  /** HTTP status returned by the QQ send API. */
  _chat_http_status?: number;
  /** Normalized quoted/referenced QQ message data, derived from message_scene/msg_elements. */
  _chat_quoted_message?: QQQuotedMessage;
  /** File attachments. */
  attachments?: QQMessageAttachment[];
  /** Structured card data for message_type=3. */
  ark_data?: QQArkData;
  /** Author metadata. */
  author?: QQMessageAuthor;
  /** Message text content. */
  content?: string;
  /** Edited timestamp. */
  edited_timestamp?: string;
  /** Passive reply context event id. */
  event_id?: string;
  /** Reference index returned by outbound message APIs. */
  ext_info?: { ref_idx: string };
  /** Legacy/alternate group id field from QQ payloads. */
  group_id?: string;
  /** Group openid field from QQ payloads. */
  group_openid?: string;
  /** Primary message id. */
  id?: string;
  /** QQ msg_id field (also used for passive reply context). */
  msg_id?: string;
  /** QQ message elements, used by newer payloads for rich/message-reference data. */
  msg_elements?: QQMessageElement[];
  /** QQ message scene metadata, including msg_idx/ref_msg_idx values. */
  message_scene?: QQMessageScene;
  /** QQ group mention payloads, if the event includes them. */
  mentions?: QQMessageMention[];
  /** QQ message type code. */
  message_type?: number;
  /** User openid from QQ payloads. */
  openid?: string;
  /** Message timestamp. */
  timestamp?: string;
  /** User openid from non-message event payloads. */
  user_openid?: string;
}

export interface QQInteractionPayload {
  application_id?: string;
  chat_type?: number;
  data?: {
    resolved?: {
      button_data?: string;
      button_id?: string;
      feature_id?: string;
      feedback_opt?: "LIKE" | "UNLIKE";
      checked?: number;
      action?: string;
      message_scene?: QQMessageScene;
      authorize_data?: {
        opt_scene?: "setting" | "dialog";
        scope?: "c2c_push" | "group_push";
      };
      message_id?: string;
      user_id?: string;
    };
    type?: number;
  };
  group_member_openid?: string;
  group_openid?: string;
  id?: string;
  message_id?: string;
  openid?: string;
  group_policy?: number;
  mention_patterns?: string[];
  require_mention?: boolean;
  scene?: "c2c" | "group" | string;
  timestamp?: string;
  /** 11=button, 12=menu; other values are platform-specific interactions. */
  type?: number;
  user_openid?: string;
  version?: number;
}

export interface QQThreadResolvableEventData {
  author?: QQMessageAuthor;
  event_id?: string;
  group_id?: string;
  group_openid?: string;
  id?: string;
  msg_id?: string;
  op_member_openid?: string;
  openid?: string;
  scene?: number | string;
  scene_param?: string;
  timestamp?: number | string;
  user_openid?: string;
}

export interface QQGroupMemberEventData extends QQThreadResolvableEventData {
  member_openid?: string;
}

export interface QQGroupJoinRequestEventData extends QQGroupMemberEventData {
  join_request_id?: string;
  risk_tips?: string;
  union_openid?: string;
  username?: string;
  apply_at?: string;
  apply_source?: "self_apply" | "invited";
  invited_by?: string;
  bot?: boolean;
  verify_info?: QQJoinVerifyInfo;
  auto_approved?: { strategy_id: string };
}

/** Async message audit result dispatched by QQ for proactive/public messages. */
export interface QQMessageAuditEventData extends QQThreadResolvableEventData {
  /** Audit task id returned by the asynchronous send path. */
  audit_id?: string;
  /** Guild channel id when the audited message belongs to a channel. */
  channel_id?: string;
  /** Guild id when the audited message belongs to a channel. */
  guild_id?: string;
  /** Audited message id. */
  message_id?: string;
}

export type QQPlatformEventType =
  | "C2C_MSG_REJECT"
  | "C2C_MSG_RECEIVE"
  | "FRIEND_ADD"
  | "FRIEND_DEL"
  | "GROUP_ADD_ROBOT"
  | "GROUP_DEL_ROBOT"
  | "GROUP_MSG_REJECT"
  | "GROUP_MSG_RECEIVE"
  | "GROUP_JOIN_REQUEST"
  | "GROUP_MEMBER_ADD"
  | "GROUP_MEMBER_REMOVE"
  | "INTERACTION_CREATE"
  | "SUBSCRIBE_MESSAGE_STATUS"
  | "MESSAGE_AUDIT_PASS"
  | "MESSAGE_AUDIT_REJECT";

export interface QQMessageEventDataMap {
  C2C_MESSAGE_CREATE: QQIncomingMessage;
  GROUP_AT_MESSAGE_CREATE: QQIncomingMessage;
  GROUP_MESSAGE_CREATE: QQIncomingMessage;
}

export interface QQActionEventDataMap {
  INTERACTION_CREATE: QQInteractionPayload;
}

export interface QQPlatformEventDataMap {
  C2C_MSG_REJECT: QQThreadResolvableEventData;
  C2C_MSG_RECEIVE: QQThreadResolvableEventData;
  FRIEND_ADD: QQThreadResolvableEventData;
  FRIEND_DEL: QQThreadResolvableEventData;
  GROUP_ADD_ROBOT: QQThreadResolvableEventData;
  GROUP_DEL_ROBOT: QQThreadResolvableEventData;
  GROUP_MSG_REJECT: QQThreadResolvableEventData;
  GROUP_MSG_RECEIVE: QQThreadResolvableEventData;
  GROUP_JOIN_REQUEST: QQGroupJoinRequestEventData;
  GROUP_MEMBER_ADD: QQGroupMemberEventData;
  GROUP_MEMBER_REMOVE: QQGroupMemberEventData;
  INTERACTION_CREATE: QQInteractionPayload;
  SUBSCRIBE_MESSAGE_STATUS: QQSubscribeMessageStatusEventData;
  MESSAGE_AUDIT_PASS: QQMessageAuditEventData;
  MESSAGE_AUDIT_REJECT: QQMessageAuditEventData;
}

export type QQKnownDispatchEventType =
  | QQActionEventType
  | QQGatewayLifecycleEventType
  | QQMessageEventType
  | QQPlatformEventType;

export interface QQPlatformEvent<
  TType extends QQPlatformEventType = QQPlatformEventType,
> {
  data: QQPlatformEventDataMap[TType] | undefined;
  eventId: string;
  payload: QQWebhookPayload<QQPlatformEventDataMap[TType], TType>;
  threadId?: string;
  type: TType;
}

export type QQPlatformEventHandler<
  TType extends QQPlatformEventType = QQPlatformEventType,
> = (event: QQPlatformEvent<TType>) => Promise<void> | void;

/** Inbound message payload from webhook/OpenAPI. */
export interface QQIncomingMessage extends QQBaseMessage {}

/** Outbound/sent message payload from OpenAPI. */
export interface QQSentMessage extends QQBaseMessage {}

/** Raw QQ message union used by adapter parse/send methods. */
export type QQRawMessage = QQIncomingMessage | QQSentMessage;

/** QQ input notify payload for msg_type=6. */
export interface QQInputNotifyPayload {
  input_type: 1;
  input_second: number;
}

/** QQ quoted-message reference payload. */
export interface QQMessageReference {
  /** Ignore a missing/inaccessible referenced message instead of failing the send. */
  ignore_get_message_error?: boolean;
  /** Message id to render as the quoted message. */
  message_id: string;
}

/** QQ-specific options that are intentionally outside Chat SDK's portable message shape. */
export interface QQSendMessageOptions {
  /** Reject Markdown messages if QQ cannot transfer their image resources. */
  forceVerifyImageResource?: boolean;
  /** Send a C2C proactive wake-up message. Mutually exclusive with passive reply context. */
  isWakeup?: boolean;
  /** QQ channel quoted-message rendering options. */
  messageReference?: QQMessageReference;
  /** Reuse cached `msg_id` / `event_id` reply context. Defaults to true. */
  passiveContext?: boolean;
}

/** QQ OpenAPI send-message request body. */
export interface QQSendMessageRequest {
  /** QQ Ark message payload. */
  ark?: QQArkPayload;
  /** Outbound message content. */
  content?: string;
  /** Passive reply context field. */
  event_id?: string;
  /** QQ input status notification payload. */
  input_notify?: QQInputNotifyPayload;
  /** C2C proactive wake-up flag. */
  is_wakeup?: boolean;
  /** QQ interactive keyboard payload. */
  keyboard?: QQKeyboardPayload;
  /** QQ markdown message payload. */
  markdown?: QQMarkdownPayload;
  /** QQ media message payload. */
  media?: QQMediaPayload;
  /** QQ channel quoted-message rendering payload. */
  message_reference?: QQMessageReference;
  /** Passive reply context field. */
  msg_id?: string;
  /** Passive reply sequence in the same msg_id context. */
  msg_seq?: number;
  /** QQ msg type: 0=text, 2=Markdown, 3=ARK, 6=input notify, 7=media. */
  msg_type: number;
}

/** QQ app access token response. */
export interface QQAccessTokenResponse {
  /** Bearer token used in `QQBot` authorization header. */
  access_token: string;
  /** Token TTL in seconds. */
  expires_in: number | string;
}

export interface QQGatewayBotResponse {
  session_start_limit?: {
    max_concurrency: number;
    remaining: number;
    reset_after: number;
    total: number;
  };
  shards?: number;
  url: string;
}

/** QQ stream message request body. */
export interface QQStreamMessageRequest {
  /** Update mode: always "replace". */
  input_mode: "replace";
  /** Stream state: 1=intermediate (generating), 10=final (done). */
  input_state: 1 | 10;
  /** Content format type. */
  content_type: "markdown";
  /** Current full message content (replace mode); must preserve the already-sent prefix. */
  content_raw: string;
  /** Passive reply context event id; mutually exclusive with msg_id. */
  event_id?: string;
  /** Passive reply context message id. */
  msg_id: string;
  /** Passive reply sequence. */
  msg_seq: number;
  /** Frame index in the stream, starting from 0. */
  index: number;
  /** Stream message ID returned from first call, required for subsequent calls. */
  stream_msg_id?: string;
}

/** QQ stream message response body. */
export interface QQStreamMessageResponse {
  /** Stream message ID. */
  id: string;
  /** Response timestamp. */
  timestamp?: string;
  /** Extended info including ref_idx. */
  ext_info?: { ref_idx: string };
  /** Remaining message length. */
  remain_msg_len?: number;
}

/** Binary input accepted by QQ upload helpers. */
export type QQBinaryData = Blob | ArrayBuffer | ArrayBufferView;

export type QQMediaImageMimeType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface QQMediaImageUploadInput {
  data: QQBinaryData;
  /** File name including an extension that matches `mimeType`. */
  fileName: string;
  mimeType: QQMediaImageMimeType;
}

export interface QQMediaImage {
  image_id: string;
  preview_url?: string;
  ttl: number;
  url: string;
}

export interface QQMediaImageListOptions {
  cursor?: string;
}

export interface QQMediaImageList {
  images: Array<{
    created_at: number;
    expires_at: number;
    file_name: string;
    image_id: string;
    preview_url?: string;
    url: string;
  }>;
  next_cursor?: string;
  total: number;
}

export interface QQMultipartUploadPrepareRequest {
  file_name: string;
  file_size: string;
  file_type: number;
  md5: string;
  md5_10m: string;
  sha1: string;
}

export interface QQMultipartUploadPart {
  block_size: string;
  index: number;
  presigned_url: string;
}

export interface QQMultipartUploadConfig {
  concurrency?: number;
  retry_delay?: number;
  retry_timeout?: number;
}

export interface QQMultipartUploadPrepareResponse {
  block_size: string;
  parts: QQMultipartUploadPart[];
  upload_config?: QQMultipartUploadConfig;
  upload_id: string;
}

export interface QQMultipartUploadPartFinishRequest {
  block_size: string;
  md5: string;
  part_index: number;
  upload_id: string;
}

export interface QQMenuSwitch {
  default: boolean;
  switch_id: string;
}

interface QQMenuItemBase {
  name: string;
}

export interface QQMenuSwitchItem extends QQMenuItemBase {
  switch: QQMenuSwitch;
  type: "switch";
}

export interface QQMenuSendMessageItem extends QQMenuItemBase {
  send_message: string;
  type: "send_message";
}

export interface QQMenuLinkItem extends QQMenuItemBase {
  link: string;
  type: "link";
}

export interface QQMenuFolderItem extends QQMenuItemBase {
  sub_menu_items: QQMenuSubItem[];
  type: "menu";
}

export type QQMenuItem =
  | QQMenuFolderItem
  | QQMenuLinkItem
  | QQMenuSendMessageItem
  | QQMenuSwitchItem;

export type QQMenuSubItem =
  | {
      link: string;
      name: string;
      type: "link";
    }
  | {
      name: string;
      send_message: string;
      type: "send_message";
    };

export interface QQMenu {
  items: QQMenuItem[];
}

export interface QQMenuResponse {
  menu?: QQMenu | null;
  version: number;
}

export interface QQMenuUpdateResponse {
  version: number;
}

export type QQPanelScope = "c2c" | "group" | "channel" | "dm";
export type QQPanelTargetType = "all" | "specific";

export type QQPanelItem =
  | {
      desc?: string;
      name: string;
      only_admin?: boolean;
      type: "command";
    }
  | {
      desc?: string;
      link: string;
      name: string;
      only_admin?: boolean;
      type: "link";
    };

export interface QQCommandPanel {
  items: QQPanelItem[];
  remark?: string;
  version?: number;
}

export interface QQCommandPanelCreateInput {
  group_openids?: string[];
  panel: QQCommandPanel;
  scope: QQPanelScope;
  target_type?: QQPanelTargetType;
  user_openids?: string[];
}

export interface QQCommandPanelCreateResponse {
  panel_id: string;
}

export interface QQCommandPanelListOptions {
  cursor?: string;
  limit?: number;
}

export interface QQCommandPanelRecord {
  created_at: string;
  panel: QQCommandPanel;
  panel_id: string;
  scope: QQPanelScope;
  target_type: QQPanelTargetType;
  updated_at: string;
  version: number;
}

export interface QQCommandPanelList {
  is_end: boolean;
  next_cursor?: string;
  records: QQCommandPanelRecord[];
}

export interface QQCommandPanelDetail extends QQCommandPanelRecord {
  group_openids?: string[];
  user_openids?: string[];
}

export interface QQCommandPanelUpdateResponse {
  version: number;
}

export interface QQCommandPanelTargetUpdateInput {
  group_openids?: string[];
  op: "add" | "del";
  user_openids?: string[];
}

export interface QQGroupInfo {
  group_class_text?: string;
  group_finger_memo?: string;
  group_member_num?: number;
  group_name?: string;
  group_openid: string;
  group_tags?: string[];
}

export interface QQGroupBotState {
  allow_proactive_msg?: boolean;
  joined_at?: string;
  member_openid?: string;
  member_role?: "member" | "admin" | "owner";
  recv_msg_setting?: "all" | "only_mention" | "mention_and_context";
}

export interface QQGroupMember {
  bot?: boolean;
  joined_at?: string;
  member_openid: string;
  member_role?: "member" | "admin" | "owner";
  union_openid?: string;
  username?: string;
}

export interface QQGroupMemberListOptions {
  cursor?: string;
}

export interface QQGroupMemberList {
  members: QQGroupMember[];
  next_cursor?: string;
}

export interface QQRemoveGroupMembersInput {
  add_to_member_blacklist?: boolean;
  member_openids: string[];
}

export interface QQRemoveGroupMembersResponse {
  add_to_member_blacklist_fail_openids?: string[];
  remove_members_result: "success" | string;
}

export interface QQGroupBlacklistUser {
  banned_at?: string;
  bot?: boolean;
  member_openid: string;
  union_openid?: string;
  username?: string;
}

export interface QQGroupBlacklistListOptions {
  cursor?: string;
  limit?: number;
}

export interface QQGroupBlacklistList {
  next_cursor?: string;
  users: QQGroupBlacklistUser[];
}

export interface QQGroupBlacklistUpdateInput {
  member_openids: string[];
  op: "add" | "del";
}

export interface QQGroupBlacklistUpdateResponse {
  fail_openids?: string[];
}

export interface QQGroupMuteScheduleRule {
  enabled: boolean;
  end_at: string;
  start_at: string;
  task_id: string;
}

export interface QQGroupMuteRecurringRule {
  enabled: boolean;
  end_time: string;
  start_time: string;
  task_id: string;
  weekdays: number[];
}

export interface QQGroupMuteState {
  global_rule?: {
    mode: "none" | "always" | "schedule";
    recurring_rules?: QQGroupMuteRecurringRule[];
    schedule_rules?: QQGroupMuteScheduleRule[];
  };
  members?: Array<{
    member_openid: string;
    mute_expire_at: string;
    union_openid?: string;
    username?: string;
  }>;
}

export interface QQGroupMemberMuteInput {
  member_openid: string;
  mute_expire_at?: string;
  op: "add" | "del" | "update";
}

export interface QQGroupMemberMuteUpdateInput {
  members: QQGroupMemberMuteInput[];
}

export interface QQJoinReviewQuestion {
  answer: string;
  question: string;
}

export interface QQJoinVerifyInfo {
  method?: "verify_message" | "admin_review_qa";
  review_qa_list?: QQJoinReviewQuestion[];
  verify_message?: string;
}

export interface QQGroupJoinRequest {
  apply_at?: string;
  apply_source?: "self_apply" | "invited";
  auto_approved?: { strategy_id: string };
  bot?: boolean;
  invited_by?: string;
  join_request_id: string;
  member_openid: string;
  risk_tips?: string;
  union_openid?: string;
  username?: string;
  verify_info?: QQJoinVerifyInfo;
}

export interface QQGroupJoinRequestListOptions {
  cursor?: string;
  limit?: number;
}

export interface QQGroupJoinRequestList {
  list: QQGroupJoinRequest[];
  next_cursor?: string;
}

export interface QQGroupJoinRequestReviewInput {
  add_to_member_blacklist?: boolean;
  join_request_id?: string;
  op: "approve" | "decline";
  reject_reason?: string;
}

export interface QQJoinApprovalStrategy {
  created_at?: string;
  expire_at?: string;
  group_ids?: number[];
  group_openids?: string[];
  is_enable?: "on" | "off";
  remark?: string;
  strategy_id: string;
  updated_at?: string;
  whitelist_user_count?: number;
}

export interface QQJoinApprovalStrategyListOptions {
  cursor?: string;
  limit?: number;
}

export interface QQJoinApprovalStrategyList {
  next_cursor?: string;
  strategies: QQJoinApprovalStrategy[];
}

export interface QQJoinApprovalStrategyCreateInput {
  expire_at?: string;
  group_ids?: number[];
  group_openids?: string[];
  is_enable?: "on" | "off";
  remark?: string;
}

export interface QQJoinApprovalStrategyCreateResponse {
  expire_at?: string;
  is_enable: "on" | "off";
  strategy_id: string;
}

export interface QQJoinApprovalStrategyUpdateInput {
  expire_at?: string;
  group_action?: {
    group_ids?: number[];
    group_openids?: string[];
    op: "add" | "del";
  };
  is_enable?: "on" | "off";
  remark?: string;
}

export interface QQJoinApprovalStrategyUpdateResponse {
  expire_at?: string;
  is_enable: "on" | "off";
}

export interface QQJoinApprovalStrategyWhitelistInput {
  op: "add" | "del";
  whitelist_users: string[];
}

export interface QQJoinApprovalStrategyWhitelistResponse {
  strategy_id: string;
  updated_at?: string;
  whitelist_user_count?: number;
}

export interface QQGeneratedUrlLink {
  url: string;
}

export interface QQGeneratedUrlLinkResponse {
  data: QQGeneratedUrlLink;
}

export interface QQSubscribeMessageTemplateResult {
  custom_template_id?: string;
  op: 1 | 2;
  subscribe_id: string;
  subscribe_ts?: number;
  template_id?: number;
  update_ts?: number;
}

export interface QQSubscribeMessageStatusEventData {
  group_openid?: string;
  openid?: string;
  result: QQSubscribeMessageTemplateResult[];
}
