# @amatsuka/chat-adapter-qq

[![npm](https://img.shields.io/npm/v/@amatsuka/chat-adapter-qq)](https://www.npmjs.com/package/@amatsuka/chat-adapter-qq)

QQ 机器人开放平台 API v2 的 [Chat SDK](https://www.npmjs.com/package/chat) 适配器。

## 功能

- 接收 QQ 私聊（C2C）和群聊消息
- 支持 Webhook 和 Socket Mode
- 发送文本、QQ Markdown、Markdown Keyboard 按钮和媒体附件
- 将按钮回调映射到 `chat.onAction`
- 支持 `chat.onDirectMessage`、`chat.openDM`、消息撤回和本进程消息缓存
- 保留 QQ 原始 payload，方便读取平台特有字段

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

export const bot = new Chat({
  userName: "my-qq-bot",
  adapters: { qq },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`收到：${message.text}`);
});

qq.onEvent("FRIEND_ADD", async (event) => {
  console.log("QQ 好友添加事件", event.data);
});
```

## Webhook

```ts
import { bot } from "./bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.qq(request);
}
```

默认会校验 QQ Webhook 签名和 `X-Bot-Appid`。回调校验挑战（`op=13`）会由适配器处理。

## Socket Mode

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

如果宿主自己维护 WebSocket，也可以把 QQ payload 交给：

```ts
await qq.handleSocketModePayload(payload);
```

## 配置

日常接入只需要 `appId` 和 `clientSecret`。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | QQ 机器人应用 ID |
| `clientSecret` | 是 | QQ 控制台密钥，用于获取 OpenAPI Access Token |
| `mode` | 否 | `webhook` 或 `socket`，默认 `webhook` |
| `userName` | 否 | Chat SDK 里的机器人名称，默认 `qq-bot` |
| `botSecret` | 否 | Webhook 签名密钥；默认使用 `clientSecret` |
| `socketMode` | 否 | Socket Mode 配置 |
| `sandbox` | 否 | 使用 QQ 沙箱 OpenAPI 域名 |
| `logger` | 否 | 自定义 Chat SDK logger |

更多高级配置可直接查看 `QQAdapterConfig` 类型。

## QQ 平台事件

消息、斜线命令和按钮点击会进入 Chat SDK 标准 handler。QQ 平台特有事件通过适配器实例监听：

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
```

## QQ 专有发送

通用文本、Markdown、Card 和媒体附件走 `thread.post()`：

```ts
await thread.post({
  raw: "图片说明",
  attachments: [
    {
      type: "image",
      url: "https://example.com/image.png",
    },
  ],
});
```

媒体附件支持 URL 或二进制 `data` / `fetchData`，支持 `image`、`video`、`audio` 和单聊 `file`。一次传入多张 `image` 时，适配器会按 QQ OpenAPI 的单个 `media` 对象拆成多条媒体消息顺序发送。上传/登记媒体后会把返回的 `file_info`、`file_uuid` 和 `ttl` 透传到 `media`，并在当前进程内按 TTL 复用；`ttl=0` 视为长期有效，未返回 TTL 时不缓存。Chat SDK `files` 暂不支持。

JSX/Card 里的 `Image({ url })` 和 `imageUrl` 会自动转成 QQ media，支持普通 URL 和 `data:image/...;base64,...`；`Text` / `CardText`、`CardLink`、`Fields`、`Table`、`Divider` 会渲染到 Markdown，`Button` / `LinkButton` 会渲染为 QQ Keyboard。

QQ 专有能力挂在适配器实例上。ARK 消息可直接调用：

```ts
await qq.postArk("qq:c2c/<openid>", {
  template_id: 23,
  kv: [
    {
      key: "#DESC#",
      value: "机器人订阅消息",
    },
  ],
});
```

Embed 在 QQ 官方 C2C/GROUP 场景下不支持，当前不适配。

## Raw Payload

QQ 官方字段会保留在 `message.raw` / `event.payload` 中。适配器只把跨平台能力映射到 Chat SDK 标准字段，平台特有数据不强行塞进标准模型。

例如引用消息会从 QQ 的 `message_scene` / `msg_elements` 中归一化到：

```ts
message.raw._chat_quoted_message;
```

原始字段也会继续保留：

```ts
message.raw.message_scene;
message.raw.msg_elements;
```

## 线程 ID

```txt
qq:c2c/<openid>
qq:group/<group_openid>
qq:guild/<guild_id>/<channel_id>
```

频道场景的 ID 已预留，但当前主要支持 C2C 和群聊。

## 能力边界

当前未实现：

- `editMessage`
- `addReaction` / `removeReaction`
- modal / options load
- schedule message
- Chat SDK `files`
- QQ Embed 发送

`fetchMessages` / `fetchMessage` 使用本进程缓存，不是 QQ 服务端历史消息查询。

## 代码风格

这个包的实现风格偏直接和保守：

- 类型先行，公开配置尽量用明确的联合类型表达约束
- 不把 QQ 平台私有概念伪装成 Chat SDK 标准字段
- 跨平台字段只映射确定语义，其他信息保留在 `raw`
- 辅助函数按职责拆小，避免单个 utils 文件持续膨胀
- 错误映射基于 HTTP 状态码和 QQ 错误码，不匹配错误文案
- 默认安全配置贴近 QQ 官方要求，测试开关显式暴露

## 开发

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

## 本地测试 Bot

仓库内置了一个最小测试 bot：

- Bot 代码：`test/bot.ts`
- 本地服务：`test/server.mjs`
- Webhook 路由：`/webhooks/qq`
- 健康检查：`/health`

### Webhook

创建 `.env.local`：

```env
QQ_APP_ID=
QQ_CLIENT_SECRET=
```

启动：

```bash
pnpm run test:bot
```

然后将 QQ 回调地址配置为：

```txt
https://<your-public-domain>/webhooks/qq
```

### Socket Mode

创建 `.env.ws.local`：

```env
QQ_APP_ID=
QQ_CLIENT_SECRET=
```

启动：

```bash
pnpm run test:bot:ws
```

可选调试：

```env
QQ_DEBUG_PAYLOADS=true
QQ_SOCKET_MODE_INTENTS=
QQ_SOCKET_MODE_SHARD=0,1
QQ_SOCKET_MODE_URL=
```

测试 bot 支持：

- 私聊任意文本：回复 `echo: <文本>`
- `/ping`
- `/md`
- `/button`
- `/image`：发送 `test/images/amatsuka.jpeg`
- `/images`：一次传入两张 `test/images/amatsuka.jpeg`
- `/jsx-image`：发送包含 `test/images/amatsuka.jpeg` 的 Card/Image JSX 消息
- `/ark`：发送 QQ Ark 消息

## 参考

- https://bot.q.qq.com/wiki/develop/api-v2/
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
