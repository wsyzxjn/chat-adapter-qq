# @amatsuka/chat-adapter-qq

基于 [chat](https://www.npmjs.com/package/chat) 的 QQ 机器人适配器（QQ 机器人开放平台 API v2）。

## 功能概览

- 支持 QQ 私聊（C2C）和群聊消息接收（Webhook / Socket Mode）
- 支持文本、QQ 原生 Markdown、Markdown Keyboard 按钮消息发送
- 支持按钮回调事件映射到 `chat.onAction`
- 支持 `chat.onDirectMessage`、`chat.openDM` 和 DM fallback ephemeral
- 支持 `chat` 流式入口降级为聚合后一次性发送
- 支持消息撤回
- 支持 QQ 回调签名校验（Ed25519）
- 支持回调校验挑战（`op=13`）
- 支持 `chat` 标准消息结构（`Message` / `Thread`）
- 支持基础消息缓存与 `fetchMessages`

## 安装

```bash
pnpm add @amatsuka/chat-adapter-qq chat @chat-adapter/state-memory
```

## 快速开始

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createQQAdapter } from "@amatsuka/chat-adapter-qq";

const qq = createQQAdapter({
  appId: process.env.QQ_APP_ID!,
  clientSecret: process.env.QQ_CLIENT_SECRET!,
  userName: "my-qq-bot",
});

const bot = new Chat({
  userName: "my-qq-bot",
  adapters: { qq },
  state: createMemoryState(),
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`收到：${message.text}`);
});

qq.onEvent("FRIEND_ADD", async (event) => {
  console.log("QQ 好友添加事件", event.data);
});
```

## Webhook 路由

```ts
import { bot } from "./bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.qq(request);
}
```

## Socket Mode

如果部署环境适合长驻进程，也可以像官方 Slack 适配器一样使用 Socket Mode，由适配器直接连接 QQ Gateway：

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createQQAdapter, QQ_INTENTS } from "@amatsuka/chat-adapter-qq";

const qq = createQQAdapter({
  appId: process.env.QQ_APP_ID!,
  clientSecret: process.env.QQ_CLIENT_SECRET!,
  mode: "socket",
  socketMode: {
    intents: QQ_INTENTS.GROUP_AND_C2C_EVENT | QQ_INTENTS.INTERACTION,
    shard: [0, 1],
  },
});

const bot = new Chat({
  userName: "my-qq-bot",
  adapters: { qq },
  state: createMemoryState(),
});

await bot.initialize();
```

`mode: "socket"` 会在 `bot.initialize()` 时启动 WebSocket；`bot.shutdown()` 会调用适配器的 `disconnect()` 并关闭连接。需要自己管理 WebSocket 时，也可以连接后把 QQ payload 交给：

```ts
await qq.handleSocketModePayload(payload);
```

## 配置项

日常接入只需要 `appId` 和 `clientSecret`。其他配置主要用于 Chat SDK 展示、本地测试或非标准部署。

### 常用配置

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | QQ 机器人应用 ID |
| `clientSecret` | 是 | QQ 控制台里的密钥，用于获取 OpenAPI Access Token |
| `mode` | 否 | 入站模式：`webhook` 或 `socket`，默认 `webhook` |
| `userName` | 否 | 机器人用户名，默认 `qq-bot` |

### 高级配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `botSecret` | `clientSecret` | Webhook 签名密钥。QQ 文档称为 Bot Secret；如果控制台只给一份密钥，通常不用传 |
| `strictWebhookEvents` | `false` | 对未支持的 webhook 事件是否返回 `400`，默认仅记录并 ACK |
| `botUserId` | 无 | 机器人用户 ID，仅用于增强 `isMe` 判断 |
| `requestTimeoutMs` | `10000` | API 请求超时时间 |
| `logger` | `ConsoleLogger` | 自定义 `chat` Logger |
| `sandbox` | `false` | 是否走沙箱 OpenAPI 域名 |
| `apiBaseUrl` | `https://api.sgroup.qq.com` | 自定义 OpenAPI Base URL，主要用于测试或代理 |
| `tokenEndpoint` | `https://bots.qq.com/app/getAppAccessToken` | 自定义 token 获取地址，主要用于测试或代理 |
| `socketMode` | 无 | Socket Mode 配置，支持 `intents`、`shard`、`url` 等 |

安全相关行为默认遵循 QQ Webhook 要求：校验签名、校验 `X-Bot-Appid`，并启用 300 秒重放窗口。测试或特殊代理链路需要覆盖时，可查看 `QQAdapterConfig` 类型。

## QQ 平台事件

消息、斜线命令和按钮点击会映射到 Chat SDK 标准 handler。QQ 平台特有事件，例如好友/群生命周期事件，通过适配器实例注册：

```ts
qq.onEvent("FRIEND_ADD", async (event) => {
  console.log(event.type, event.data);
});

qq.onEvent(["GROUP_ADD_ROBOT", "GROUP_DEL_ROBOT"], async (event) => {
  console.log(event.type, event.data);
});

const unsubscribe = qq.onEvent(async (event) => {
  console.log("QQ platform event", event.type);
});

unsubscribe();
```

## 线程 ID 规则

适配器内部线程 ID：

```txt
qq:c2c/<openid>
qq:group/<group_openid>
qq:guild/<guild_id>/<channel_id>   # 频道场景（预留）
```

## 当前能力边界

与 `chat@4.28.1` 的主要入口对齐情况：

| Chat SDK 能力 | QQ 适配器行为 |
| --- | --- |
| `bot.webhooks.qq` | 支持 Webhook 模式 |
| `qq.startSocketMode` / `qq.stopSocketMode` | 支持 Socket Mode |
| `onDirectMessage` / `onNewMention` / `onSubscribedMessage` / `onNewMessage` | 支持，QQ 消息会映射为标准 `Message` |
| `onSlashCommand` | 支持，基于 Chat SDK 标准 slash command 事件 |
| `onAction` | 支持 QQ Markdown Keyboard 按钮回调 |
| `thread.post` / `channel.post` | 支持文本、Markdown、Card + Keyboard |
| `thread.post(stream)` | 支持降级：收集文本/`markdown_text` chunk 后一次性发送 |
| `thread.postEphemeral(..., { fallbackToDM: true })` | 支持，通过 C2C 私聊降级发送 |
| `bot.openDM` | 支持，生成 `qq:c2c/<openid>` |
| `deleteMessage` | 支持 C2C / group 撤回 |
| `fetchMessages` / `fetchMessage` | 支持本进程消息缓存，不是 QQ 服务端历史查询 |
| `startTyping` | no-op；QQ 官方 Bot OpenAPI v2 当前没有通用 typing 能力 |
| `channel.threads` | 空结果；当前模型是会话即 thread/channel |

以下能力暂未实现，会抛 `NotImplementedError` 或由 Chat SDK 返回不支持：

- `editMessage`
- `addReaction` / `removeReaction`
- `openModal` / `onModalSubmit` / `onModalClose`
- `onOptionsLoad`
- `scheduleMessage`
- `postObject` / `editObject`
- 直接二进制文件上传（`files` / `attachments`）
- ARK / Embed / Media 消息发送

## 错误处理说明

- 适配器不会在本地按文案判断“主动/被动回复”场景
- 统一以 QQ 服务端返回为准，基于 HTTP 状态码和 OpenAPI 错误码（`code/errcode`）映射到 `chat` 标准错误类型

## 开发

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

## 测试 Bot（本地服务）

仓库内置了一个最小测试 bot：

- Bot 代码：`test/bot.ts`
- 本地服务：`test/server.mjs`
- Webhook 路由：`/webhooks/qq`
- 健康检查：`/health`

### 支持的测试指令

- 私聊任意文本：回复 `echo: <文本>`
- `/ping`：回复 `pong <ISO 时间>`
- `/md`：发送 QQ 原生 Markdown
- `/button`：发送 Markdown Keyboard 并测试按钮回调

### 必要环境变量

最少只需要填写 `QQ_APP_ID` 和 `QQ_CLIENT_SECRET`。如果控制台只给你一份“密钥/Secret”，就填到 `QQ_CLIENT_SECRET`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `QQ_APP_ID` | 是 | QQ 机器人应用 ID |
| `QQ_CLIENT_SECRET` | 是 | QQ 控制台里的密钥，用于 AccessToken；默认也用于 Webhook 验签 |
| `QQ_BOT_SECRET` | 否 | 一般留空；仅当 Webhook 签名密钥与 `QQ_CLIENT_SECRET` 不同时填写 |
| `QQ_BOT_USER_ID` | 否 | 增强 `isMe` 判断，不影响基础收发 |
| `BOT_USERNAME` | 否 | bot 名称，默认 `qq-test-bot` |
| `QQ_VERIFY_SIGNATURE` | 否 | 默认 `true` |
| `QQ_REQUIRE_APP_ID_HEADER` | 否 | 默认 `true` |
| `QQ_SANDBOX` | 否 | `true` 时走沙箱 |
| `QQ_MODE` | 否 | `socket` / `websocket` / `ws` 时使用 Socket Mode；默认 Webhook |
| `QQ_SOCKET_MODE_INTENTS` | 否 | 自定义 Gateway intents 数值 |
| `QQ_SOCKET_MODE_SHARD` | 否 | 自定义分片，格式如 `0,1` |
| `QQ_SOCKET_MODE_URL` | 否 | 自定义 WSS 地址；默认自动调用 `/gateway/bot` 获取 |
| `QQ_STRICT_WEBHOOK_EVENTS` | 否 | `true` 时未支持事件返回 400 |
| `QQ_DEBUG_WEBHOOK` | 否 | `true` 时测试服务输出 webhook 调试日志 |

### 启动本地服务

```bash
pnpm run test:bot
```

`test:bot` 会先自动执行构建，避免测试 bot 通过包名导入时读到旧的 `dist`。

启动后将 QQ 回调地址配置为：

```txt
https://<your-public-domain>/webhooks/qq
```

### 启动 Socket Mode 测试 Bot

如果 WebSocket 使用另一套机器人配置，可以单独创建 `.env.ws.local`，然后运行：

```bash
pnpm run test:bot:ws
```

`test:bot:ws` 会读取 `.env.ws.local`，并强制设置 `QQ_MODE=ws`。`.env.ws.local` 至少需要：

```env
QQ_APP_ID=
QQ_CLIENT_SECRET=
```

可选项：

```env
QQ_SOCKET_MODE_INTENTS=
QQ_SOCKET_MODE_SHARD=0,1
QQ_SOCKET_MODE_URL=
```

## 参考

- https://bot.q.qq.com/wiki/develop/api-v2/
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
