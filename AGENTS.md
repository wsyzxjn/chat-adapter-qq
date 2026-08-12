# AGENTS.md

本文件给维护 `@amatsuka/chat-adapter-qq` 的智能体/开发者提供约束与操作说明。

## 1. 项目目标

- 提供基于 `chat` SDK 的 QQ 适配器
- 当前范围：QQ API v2 + Webhook 模式 + Socket Mode
- 当前支持：`C2C` 私聊、`GROUP` 群聊

## 2. 目录与入口

- 入口：`src/index.ts`
- 适配器实现：`src/adapter.ts`
- 常量定义：`src/constants.ts`
- 通用辅助：`src/utils/`
- 类型定义：`src/types.ts`
- 文本格式转换：`src/format-converter.ts`
- 本地测试 Bot：`test/bot.ts`
- 本地测试服务：`test/server.mjs`

## 3. 关键行为约束

### 3.1 Webhook

- 只接受 `POST`
- 默认强制校验：
  - `X-Signature-Ed25519`
  - `X-Signature-Timestamp`
  - `X-Bot-Appid`（可通过配置关闭强制）
- 默认启用签名重放窗口（`webhookReplayWindowSec`，默认 300 秒）
- 回调校验（`op=13`）必须返回 `plain_token + signature`
- 回调校验（`op=13`）按 QQ 文档不要求 `X-Signature-*`，不要先强制验签
- 非支持事件默认 ACK 并记录日志；`strictWebhookEvents=true` 时返回 400
- `INTERACTION_CREATE` 必须先调用 `/interactions/{interaction_id}` ACK，再派发到 `chat.processAction`

### 3.2 发消息策略

- 不在本地强制区分主动/被动，统一以服务端返回为准
- 服务端拒绝后映射为标准 `ChatError`（例如 `PERMISSION_DENIED`）
- 被动上下文（`msg_id/msg_seq/event_id`）从入站消息缓存并在发送时自动带上
- 入站消息事件必须按 `msg_id` + `msg_seq` / `message_scene.ext.msg_idx` 去重；重复投递只 ACK/no-op，不得再次 `processMessage` / slash
- 富媒体发送：`msg_type=7` 只带 `media`，说明文字走单独的 text/markdown 消息，避免混用触发 `22006`
- 本地/二进制附件超过分片阈值走 `upload_prepare` / part PUT / `upload_part_finish`，小文件仍用 `file_data`
- 错误分类仅基于 HTTP 状态码 + QQ 返回错误码（`code` → `errcode` → `err_code`），禁止使用错误文案关键词匹配

### 3.3 Socket Mode

- `mode="socket"` 时由适配器在 `initialize()` 后启动 QQ Gateway WebSocket 连接
- 也允许宿主自行维护 WebSocket，并调用 `handleSocketModePayload(payload)` 投递 QQ payload
- Webhook 与 Socket Mode 的 `op=0 Dispatch` 必须复用同一套事件解析/派发逻辑
- Gateway 必须处理：
  - `op=10` Hello 后发送心跳与 Identify/Resume
  - `op=1` Heartbeat / `op=11` Heartbeat ACK
  - `op=7` Reconnect
  - `op=9` Invalid Session
- 默认 intents 覆盖当前范围：`GROUP_AND_C2C_EVENT | INTERACTION | MESSAGE_AUDIT`（可通过 `socketMode.intents` 覆盖）
- `disconnect()` 必须关闭 Socket Mode 连接和定时器

### 3.4 线程 ID

当前格式：

- `qq:c2c/<openid>`
- `qq:group/<group_openid>`
- `qq:guild/<guild_id>/<channel_id>`

如要扩展频道场景，先统一 ID 设计，再改 `encodeThreadId/decodeThreadId/channelIdFromThreadId`。

### 3.5 群管理（changelog 20260810）

QQ 专有方法挂在适配器实例上（与 `postArk` / `postQQMessage` 相同），不要发明 Chat SDK 标准 API。

- 禁言：`getGroupMuteSetting`、`setGroupMemberMute`（单次最多 10 个普通成员）
- 入群申请：`getGroupJoinRequests`（cursor/limit，默认 20、最大 100）、`approveGroupJoinRequest`（`decline` 才允许 `reject_reason` / `add_to_member_blacklist`）
- 入群自动审批策略：`getGroupJoinApprovalStrategies`、`createGroupJoinApprovalStrategy`、`updateGroupJoinApprovalStrategy`、`deleteGroupJoinApprovalStrategy`、`executeGroupJoinApprovalStrategy`、`updateGroupJoinApprovalWhitelist`
- 事件 `GROUP_JOIN_REQUEST` 走现有 `qq.onEvent`（webhook + socket 共用）；intent 为 `GROUP_AND_C2C_EVENT`；仅群管理员机器人可收到；下行自动通过时保留 `auto_approved.strategy_id`
- 群标识接受 `qq:group/<group_openid>` 或原始 `group_openid`
- 管理接口要求机器人为群管理员；管理员未通过是 QQ `11282` → `PERMISSION_DENIED`（也识别 body 里的 `err_code`）

官方 wiki 的群管理目录页目前几乎为空；HTTP 路径以 changelog 20260810 与 OpenAPI 形状为准：

- `GET|POST /v2/groups/{group_openid}/restrict_chat_setting`
- `GET /v2/groups/{group_openid}/join_request_list`
- `POST /v2/groups/{group_openid}/approval_join_request/{member_openid}`
- `/v2/groups/join_approval_strategy` 及 `/{strategy_id}`、`/execute`、`/whitelist_users`

## 4. 错误处理规范

- 优先使用 `chat` 标准错误类型（`ChatError`, `RateLimitError`, `NotImplementedError`）
- 不新增平台私有异常类型，除非有强需求且经过明确讨论
- 错误码读取顺序：`code` → `errcode` → `err_code`（新 wiki 失败体用 `err_code`）
- `11282`（ErrorCheckAdminNotPass）→ `PERMISSION_DENIED`；`11281`（ErrorCheckAdminFailed）是可重试系统错误，保持未映射
- `11298` 是 IP 白名单拒绝，Chat SDK 仍映射为 `PERMISSION_DENIED`，不要当成缺群管理员
- Webhook 错误返回统一结构：
  - `{ error: { code, message, details? } }`

## 5. 当前未实现能力（保持显式）

- `editMessage`
- `addReaction` / `removeReaction`
- modal / options load
- schedule message
- QQ Embed 发送
- 群基本信息 / 机器人群内状态（`getGroupInfo` / `getGroupBotState`，官方白名单 + 30 QPM）
- 频道（guild/channel）管理与消息

以上必须继续显式 `NotImplementedError`，不要静默吞掉。Chat SDK `files` 已实现，走与附件相同的上传/发送路径。

## 6. 本地开发命令

```bash
pnpm run dev
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run test:bot
```

## 7. 变更检查清单

每次修改 `src/adapter.ts` 后至少完成：

1. `pnpm run typecheck`
2. `pnpm run test`
3. `pnpm run build`
4. 确认 webhook 关键分支未退化：
   - 验签失败 -> 401
   - JSON 解析失败 -> 400
   - `op=13` 正常挑战应答
   - 非支持事件在 strict/non-strict 模式行为正确
   - `INTERACTION_CREATE` 先 ACK interaction，再派发 action
   - `GROUP_JOIN_REQUEST` 走 `onEvent`，不进入 `processMessage`
