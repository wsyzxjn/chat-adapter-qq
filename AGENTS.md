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
- 通用辅助：`src/utils.ts`
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
- 错误分类仅基于 HTTP 状态码 + QQ 返回错误码（`code/errcode`），禁止使用错误文案关键词匹配

### 3.3 Socket Mode

- `mode="socket"` 时由适配器在 `initialize()` 后启动 QQ Gateway WebSocket 连接
- 也允许宿主自行维护 WebSocket，并调用 `handleSocketModePayload(payload)` 投递 QQ payload
- Webhook 与 Socket Mode 的 `op=0 Dispatch` 必须复用同一套事件解析/派发逻辑
- Gateway 必须处理：
  - `op=10` Hello 后发送心跳与 Identify/Resume
  - `op=1` Heartbeat / `op=11` Heartbeat ACK
  - `op=7` Reconnect
  - `op=9` Invalid Session
- 默认 intents 只覆盖当前范围：`GROUP_AND_C2C_EVENT | INTERACTION`
- `disconnect()` 必须关闭 Socket Mode 连接和定时器

### 3.4 线程 ID

当前格式：

- `qq:c2c/<openid>`
- `qq:group/<group_openid>`
- `qq:guild/<guild_id>/<channel_id>`

如要扩展频道场景，先统一 ID 设计，再改 `encodeThreadId/decodeThreadId/channelIdFromThreadId`。

## 4. 错误处理规范

- 优先使用 `chat` 标准错误类型（`ChatError`, `RateLimitError`, `NotImplementedError`）
- 不新增平台私有异常类型，除非有强需求且经过明确讨论
- Webhook 错误返回统一结构：
  - `{ error: { code, message, details? } }`

## 5. 当前未实现能力（保持显式）

- `editMessage`
- `addReaction` / `removeReaction`
- 二进制文件直传（`files` / `attachments`）

以上必须继续显式 `NotImplementedError`，不要静默吞掉。

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
