# QQ API v2 与 Chat SDK 能力对照

核对日期：2026-10-26。依据当日可访问的 QQ 官方文档（站点资源版本 v1.43.0），最新变更记录为 2026-10-21；Chat SDK 按 npm 稳定版 4.43.0 的发布包类型、源码及配套文档核对。

本项目当前范围为 C2C 与群聊，接收方式包括 Webhook、内置 Gateway 和宿主转发 Socket payload。本表区分平台提供的能力与适配器实际实现，未把接口文档存在视为当前机器人已获得调用权限。

## 官方近期变更

| 日期 | 官方变更 | 本项目状态 |
| --- | --- | --- |
| 2026-10-21 | 素材图片管理，新增 `qqbot-media://` 引用 | 已实现 prepare、预签名 PUT、complete、列表与删除 |
| 2026-09-16 | 分享链接字段修订；入站 ARK 类型增加 `picture` | 已实现分享链接接口并补齐入站结构化卡片类型 |
| 2026-09-03 | 群成员列表、详情、批量移除、黑名单 | 已实现全部管理方法；部分接口仍有内邀/白名单限制 |
| 2026-08-12 | 自定义菜单与指令面板管理 | 已实现菜单与面板 CRUD、关联对象修改和快捷菜单回调 |
| 2026-08-10 | 统一调用域名；Markdown 图片校验；禁言、入群审批、自动审批策略及事件 | 已实现域名、图片校验、禁言、审批和自动审批策略 |

来源：[官方变更记录](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html)。

## 本次修正

- 生产 API 与获取 Access Token 的默认地址统一为 `https://api.bot.qq.com`。显式配置 `apiBaseUrl`、`tokenEndpoint` 时仍使用调用方提供的地址。沙箱域名没有在本轮取得新的官方地址依据，未推测替换。
- 统一解析 `err_code`、`code`、`errcode`，以当前通用契约的 `err_code` 优先。HTTP 200 中的业务错误会抛出标准错误；token 接口的业务限流、认证错误也会正确分类。HTTP 201/202 继续标记为异步接受，保留实际业务码，不能视为已经送达。
- 补充当前收发、媒体与流式接口的错误分类，包括主动消息限流、用户拒收、被动回复过期、消息过长与流式 `50002` 限流。仅依据状态码和数值错误码，错误描述不参与判断。响应体的 `trace_id` 会保留在错误描述中。
- Markdown/Card 支持 `qqbot-media://image/v1/<token>` 图片引用；`postQQMessage` 的 `forceVerifyImageResource` 对应 `markdown.force_verify_image_resource`，仅适用于独立 Markdown/Card 消息。
- 二进制上传携带官方要求的 `file_name`，有名称时保留名称；内容相同但名称不同的文件不再共用同一个上传缓存项。超过 5 MiB 时自动执行官方分片上传、文件合并和并发/重试配置。
- 提供 Markdown 素材图片的 prepare、预签名 PUT、complete、列表和删除方法；图片与 MIME 类型在请求前校验。
- 提供全局自定义菜单、指令面板 CRUD、面板关联对象和分享链接方法。
- 提供群信息、机器人群内状态、成员列表/详情、批量移除、黑名单、禁言、入群申请审批、自动审批策略 CRUD/执行/白名单方法。
- 入站类型补充 `ark_data`、`picture` 卡片、成员角色、跨应用账号、嵌套消息元素与发送响应的 `ext_info.ref_idx`。
- 按钮与快捷菜单（互动 type=11/12）先 ACK 再交给 Chat SDK Action。其他互动（反馈、清空会话、授权等）通过平台事件监听交付，不自动 ACK，也不误当按钮。
- 支持 `GROUP_MEMBER_ADD`、`GROUP_MEMBER_REMOVE`、`GROUP_JOIN_REQUEST` 及 `GROUP_MEMBER_EVENT` intent。默认 intents 保持原范围，需调用方显式订阅成员事件。
- 支持 `SUBSCRIBE_MESSAGE_STATUS`，原样交付订阅模板授权结果及 `subscribe_id`。
- 只有官方允许回复的平台事件才更新被动回复上下文；事件回复替换旧消息上下文，成员变动、审核结果、消息反馈等不会覆盖消息回复对象。
- Gateway 关闭码 `4900`–`4913` 使用新 Identify，`4001/4002` 停止自动重连；已有 `4006/4007` 新 Identify、`4009` Resume 与权限类终止策略继续保留。
- Chat SDK 与开发用内存 state adapter 升级至 4.43.0。新增的 Card `text_input` 在 QQ 上没有对应表单能力，显式抛出 `NotImplementedError`。

同一批本地改动还保留 issue #2 的修复：流式 `replace` 帧使用原始累计文本，避免 Markdown 自动补全改写已发送前缀而触发 `40007`；流式发送及降级回复固定原入站消息的 `msg_id` 和序号，不被后续入站消息改变。

## 已覆盖的能力

| 能力 | 实现与限制 |
| --- | --- |
| C2C 与群消息接收 | `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_MESSAGE_CREATE` 进入共用解析流程；全量群消息需 QQ 侧启用 |
| 文本、Markdown、Card | 文本、Markdown、常用 Card 元素与 Keyboard；无 QQ 对应组件时显式报不支持 |
| 被动/主动消息 | 自动缓存消息或可回复事件上下文；不在本地预判主动/被动配额与权限，服务端拒绝后映射标准错误 |
| 召回消息 | C2C `isWakeup`，自动排除被动上下文；周期和配额由 QQ 判断 |
| C2C 原生流式 | `stream_messages`、固定消息上下文与序号、递增帧 index、结束帧 `input_state=10`；没有建立原生流或协议失败时降级为普通消息 |
| 群流式 | QQ 未提供该接口；先收集文本再发送普通消息 |
| 正在输入 | C2C `msg_type=6`，群聊不发送输入状态请求 |
| 媒体与文件 | URL、≤5 MiB 二进制直传、>5 MiB 自动分片上传与合并；软限制自动降级为文件；一次消息一个 media，多附件拆分；缓存遵守 TTL |
| 平台素材 | 图片 prepare、PUT、complete、列表和删除；HTTP(S) 和 `qqbot-media://image/v1/...` 图片直接渲染为 Markdown；data URL Card 图片走媒体上传 |
| 引用消息 | 入站提取 `message_scene.ext` / `msg_elements`；出站支持 QQ 专用 `messageReference`，引用索引来自入站 `msg_idx` 或已发送消息的 `ext_info.ref_idx` |
| 撤回 | C2C 与群聊 DELETE；官方时限为两分钟；群管理员可撤回普通成员消息，实际权限由服务端判断 |
| 按钮和菜单互动 | type=11/12 ACK 后进入 `onAction`；其他互动走 `qq.onEvent("INTERACTION_CREATE", ...)` |
| 菜单与指令面板 | 全局菜单 GET/PUT；面板列表、创建、详情、修改、删除和关联对象更新；支持 `c2c/group/channel/dm` 配置 |
| 分享链接 | `generateQQUrlLink()` 调用官方 `/v2/generate_url_link` |
| 好友、群与成员事件 | 好友增删、主动推送开关、机器人入退群、成员加入/退出/入群申请；成员事件需要 `GROUP_MEMBER_EVENT`，申请事件要求群管理员身份 |
| 群管理与审批 | 群信息、机器人状态、成员列表/详情/批量移除、黑名单、禁言、入群申请审批和自动审批策略 |
| 订阅消息事件 | `SUBSCRIBE_MESSAGE_STATUS` 进入 `qq.onEvent`，提供模板授权状态和 `subscribe_id` |
| 异步审核 | 201/202 接受状态与 `MESSAGE_AUDIT_PASS/REJECT` 回调；Socket 模式需订阅审核 intent |
| Webhook | POST、AppID、Ed25519 签名、重放窗口、无签名的 op=13 挑战、ACK 与 strict 事件处理 |
| Gateway | Hello、Identify、Resume、心跳/ACK、Reconnect、Invalid Session、推荐分片与启动并发限制、关闭码策略、disconnect 清理 |
| Chat SDK 历史 | `persistThreadHistory` 启用 state-backed 历史；平台自身未提供通用历史查询，直接 fetch 方法只读取本地缓存 |

## 官方 C2C / 群聊接口覆盖

适配器已覆盖本次核对范围内的 33 个管理、配置和上传端点，并为这些方法导出完整请求/响应类型。实现复用现有鉴权、超时、错误映射和请求层；分片上传使用 Node 内置哈希能力，没有引入第二套 QQ 客户端。

公开方法分为以下组：

| 能力组 | 方法 |
| --- | --- |
| Markdown 素材 | `uploadQQMediaImage`、`listQQMediaImages`、`deleteQQMediaImage` |
| 菜单 | `getQQMenu`、`updateQQMenu` |
| 指令面板 | `listQQCommandPanels`、`createQQCommandPanel`、`getQQCommandPanel`、`updateQQCommandPanel`、`deleteQQCommandPanel`、`updateQQCommandPanelTargets` |
| 群信息与成员 | `getQQGroupInfo`、`getQQGroupBotState`、`listQQGroupMembers`、`getQQGroupMember`、`removeQQGroupMembers` |
| 黑名单与禁言 | `listQQGroupMemberBlacklist`、`updateQQGroupMemberBlacklist`、`getQQGroupMuteState`、`updateQQGroupMemberMute` |
| 入群审批 | `listQQGroupJoinRequests`、`reviewQQGroupJoinRequest` |
| 自动审批 | `listQQGroupJoinApprovalStrategies`、`createQQGroupJoinApprovalStrategy`、`updateQQGroupJoinApprovalStrategy`、`deleteQQGroupJoinApprovalStrategy`、`executeQQGroupJoinApprovalStrategy`、`updateQQGroupJoinApprovalStrategyWhitelist` |
| 分享链接 | `generateQQUrlLink` |

群管理方法同时接受原始 group openid 和 `qq:group/<openid>` 线程 ID。群信息、机器人群内状态和成员相关接口当前仍可能受 QQ 白名单或内邀限制；审批、禁言、移除等操作还要求对应管理员权限。方法已接入，不代表任意机器人账号一定拥有平台侧调用资格。

## Chat SDK 4.43 边界

发布包中与本适配器有关的新增可选接口包括 `endTyping`、`markAsRead`、`reply`、`getConcurrencyScope` 和回合取消声明等。QQ 当前 C2C/群聊没有在本次文档核对中提供相应的通用实现依据，因此没有创建空方法或宣称支持。标准 `thread.post` 的流取消和历史协调交给 SDK 既有实现。

`editMessage`、`addReaction`、`removeReaction` 与 Card 表单输入保持显式不支持；其他未实现的 SDK 可选方法由 SDK 按自身规则报错或处理。支持 QQ `messageReference` 不等同于已实现 Chat SDK 的通用 `reply` 方法。

## 当前范围外

频道/Guild 消息、频道私信、频道表情表态、Guild/Channel 管理和对应事件仍不在本项目当前声明范围内。指令面板配置方法本身允许 `channel`/`dm` scope，因为这属于全局面板管理接口；这不代表适配器已经支持频道消息收发。

## 官方文档中的歧义与验证范围

- 单聊被动回复：概述与单聊接口页首写 60 分钟，单聊请求表中的 `msg_id` 说明仍写 5 分钟。本适配器不增加本地过期阻断，以实际 QQ 响应为准。
- 通用 API 指南使用 `err_code`，token 接口明确使用 `code`，部分既有接口/返回也使用 `errcode`，因此错误提取覆盖三种实际字段。
- WebSocket 部分页的示例鉴权仍写已废弃的 Bot Token；当前使用 `QQBot ACCESS_TOKEN`，按最新凭证与调用指南执行。
- 本次验证为官方文档核对、发布包接口核对和本地 mock 回归测试，不代表已经在真实机器人账号上验证了权限、投递、素材有效期或管理接口可用性。

## 主要来源

- [统一 API、错误响应与追踪](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)
- [Access Token、业务错误与刷新](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [原生流式](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)
- [富媒体](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)、[单聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)、[群聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)
- [单聊入站消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)、[群全量消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- [互动事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)、[互动 ACK](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html)
- [群成员加入](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_member_add.html)、[退出](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_member_remove.html)、[入群申请](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html)
- [素材管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)、[单聊预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_prepare.post.html)、[群聊预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html)
- [自定义菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html)、[指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html)、[分享链接](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_generate_url_link.post.html)
- [群成员](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members.get.html)、[黑名单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_member_blacklist.post.html)、[禁言](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html)、[自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.post.html)
- [订阅消息状态](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/subscribe_message_status.html)
- [Webhook](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[Gateway](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[Payload 与 Intents](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)
- [Chat SDK 适配器实现指南](https://chat-sdk.dev/docs/contributing/building)、[Chat SDK 发布包](https://www.npmjs.com/package/chat/v/4.43.0)
