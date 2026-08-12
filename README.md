# @amatsuka/chat-adapter-qq

[![npm](https://img.shields.io/npm/v/@amatsuka/chat-adapter-qq)](https://www.npmjs.com/package/@amatsuka/chat-adapter-qq)

QQ 机器人开放平台 API v2 的 [Chat SDK](https://www.npmjs.com/package/chat) 适配器。

## 功能

- 接收 QQ 私聊（C2C）和群聊消息
- 支持 Webhook 和 Socket Mode
- 发送文本、QQ Markdown、Markdown Keyboard、媒体附件和 Chat SDK `files`
- 将按钮回调映射到 `chat.onAction`
- 支持 `chat.onDirectMessage`、`chat.openDM`、消息撤回和 Chat SDK 状态持久化历史
- 保留 QQ 原始 payload，方便读取平台特有字段
- 群禁言、入群申请审批、入群自动审批策略，以及 `GROUP_JOIN_REQUEST` 事件

## 安装

```bash
pnpm add @amatsuka/chat-adapter-qq chat @chat-adapter/state-memory
```

要求 Node.js 20 或更高版本；当前适配器基于 Chat SDK 4.34。

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
    intents:
      QQ_INTENTS.GROUP_AND_C2C_EVENT |
      QQ_INTENTS.INTERACTION |
      QQ_INTENTS.MESSAGE_AUDIT,
  },
});

const bot = new Chat({
  userName: "my-qq-bot",
  adapters: { qq },
  state: createMemoryState(),
});

await bot.initialize();
```

默认会读取 `/gateway/bot` 的 `shards` 与 `session_start_limit`，自动启动全部推荐分片并遵守 Identify 并发限制。设置 `shard: [index, total]` 可只启动指定分片，设置 `autoSharding: false` 可强制单分片。连接会按 QQ Gateway 关闭码选择 Resume、重新 Identify 或停止重连，并使用带上限的指数退避。

默认 Gateway intents 为 `GROUP_AND_C2C_EVENT | INTERACTION | MESSAGE_AUDIT`，因此主动/public 发送返回 HTTP 201/202 后可以收到 `MESSAGE_AUDIT_PASS` / `MESSAGE_AUDIT_REJECT`。仍可通过 `socketMode.intents` 覆盖。

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
| `sandbox` | 否 | 使用 QQ 沙箱 OpenAPI 域名（`sandbox.api.sgroup.qq.com`） |
| `apiHost` | 否 | OpenAPI 主机族：`sgroup`（默认，历史域名）或 `bot`（当前 wiki 的 `api.bot.qq.com`） |
| `apiBaseUrl` | 否 | 覆盖 OpenAPI 根地址 |
| `tokenEndpoint` | 否 | 覆盖 Access Token 地址 |
| `hostFallback` | 否 | 使用默认主机时，token 网络/`NOT_FOUND` 失败会尝试另一主机族并粘滞切换；默认 `true` |
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

主动/public 消息被 QQ 以 HTTP 201/202 异步接受时，返回消息的 `raw._chat_delivery_status` 为 `accepted`，并保留 `_chat_http_status`、`_chat_async_code` 和 `_chat_async_message`。后续结果可通过 `MESSAGE_AUDIT_PASS` / `MESSAGE_AUDIT_REJECT` 监听。Socket Mode 默认已包含 `QQ_INTENTS.MESSAGE_AUDIT`。

`GROUP_JOIN_REQUEST`（changelog 20260810）也走 `qq.onEvent`。它挂在 `GROUP_AND_C2C_EVENT` 上，只有机器人为**群管理员**时才会下发。Webhook 与 Socket Mode 共用同一套解析。自动审批通过的下行事件会带 `auto_approved.strategy_id`：

```ts
qq.onEvent("GROUP_JOIN_REQUEST", async (event) => {
  const request = event.data;
  console.log(event.threadId, request?.join_request_id, request?.auto_approved?.strategy_id);

  if (request?.member_openid && request.join_request_id && !request.auto_approved) {
    await qq.approveGroupJoinRequest(event.threadId ?? request.group_openid!, request.member_openid, {
      op: "approve",
      join_request_id: request.join_request_id,
    });
  }
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

Chat SDK `files` 也会走同一上传流程：

```ts
import { readFile } from "node:fs/promises";

await thread.post({
  raw: "月报",
  files: [
    {
      data: await readFile("./report.pdf"),
      filename: "report.pdf",
      mimeType: "application/pdf",
    },
  ],
});
```

媒体附件支持 URL 或二进制 `data` / `fetchData`，支持 `image`、`video`、`audio` 和 C2C/群聊 `file`。QQ OpenAPI 每条消息只接受一个 `media` 对象，因此多个附件/文件会按输入顺序拆成多条消息。说明文字会先作为独立的 text/markdown 消息发送，媒体本身使用干净的 `msg_type=7`（不混写 `content`，避免官方错误码 `22006`）。上传/登记媒体后会把返回的 `file_info`、`file_uuid` 和 `ttl` 透传到 `media`，并在当前进程内按 TTL 复用；`ttl=0` 视为长期有效，未返回 TTL 时不缓存。

本地/二进制附件默认超过 **8 MiB** 时走官方分片上传（`upload_prepare` → 预签名 PUT → `upload_part_finish` → `POST .../files` 携带 `upload_id`）；更小的二进制仍用 `file_data`。公网 URL 始终走简单 `POST .../files`。可用 `chunkedUploadThresholdBytes` 覆盖阈值。超过软限制的图片/视频/语音会按文档降级为 `file_type=4`；超过 200MB 硬限制会抛出 `ChatError`。

JSX/Card 里的 `Image({ url })` 和 `imageUrl` 会自动转成 QQ media，支持普通 URL 和 `data:image/...;base64,...`；`Text` / `CardText`、`CardLink`、`Fields`、`Table`（含 `caption`）、`Chart`、`Divider` 会渲染到 Markdown，`Button` / `LinkButton` 会渲染为 QQ Keyboard。

Chat SDK 能表达的按钮会映射为：

- `Button` → 回调按钮（`action.type=1`）
- `LinkButton` → 跳转按钮（`action.type=0`）
- `style: "primary"` → QQ `render_data.style=3`（蓝底白字）
- `style: "danger"` / 默认 → `style=0`（灰线框；QQ 没有红色样式）

QQ 指令按钮（`action.type=2`）、`enter` / `reply` / `anchor`、样式 `2` 目前没有对应的 Chat SDK 字段，不会伪造 API；`actionType: "modal"` 会显式 `NotImplementedError`。

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

需要使用 QQ 平台专有字段时，可调用 `postQQMessage`。`isWakeup` 会发送 C2C 主动唤醒消息，并自动禁用缓存的被动回复上下文；`messageReference` 会原样映射为 QQ `message_reference`，具体场景权限仍由 QQ 服务端判定。

```ts
await qq.postQQMessage("qq:c2c/<openid>", "主动提醒", {
  isWakeup: true,
});

await qq.postQQMessage("qq:c2c/<openid>", "引用回复", {
  messageReference: {
    message_id: "<message_id>",
    ignore_get_message_error: true,
  },
});
```

C2C `stream()` 在存在入站 `msg_id` 被动上下文时使用 QQ 原生 `stream_messages`，并在整个流中固定使用同一个 `msg_seq`；主动场景或协议调用失败时会安全降级为普通消息。

Embed 在 QQ 官方 C2C/GROUP 场景下不支持，当前不适配。

## 群管理

changelog 20260810 的群禁言、入群申请和入群自动审批策略挂在适配器实例上，不是 Chat SDK 标准 API。调用方需要机器人为**群管理员**；QQ 拒绝时按 HTTP 状态码 + `code`/`errcode` 映射为 `ChatError`（例如 `PERMISSION_DENIED`）。`group` 参数可以是 `qq:group/<group_openid>` 或原始 group openid。

```ts
const setting = await qq.getGroupMuteSetting("qq:group/<group_openid>");
console.log(setting.global_rule, setting.members);

await qq.setGroupMemberMute("qq:group/<group_openid>", [
  {
    op: "add",
    member_openid: "<member_openid>",
    mute_expire_at: "2026-08-12T12:00:00+08:00",
  },
]);

await qq.setGroupMemberMute("<group_openid>", [
  { op: "del", member_openid: "<member_openid>" },
]);

const page = await qq.getGroupJoinRequests("<group_openid>", {
  cursor: "",
  limit: 20,
});
const request = page.list?.[0];
if (request) {
  await qq.approveGroupJoinRequest("<group_openid>", request.member_openid, {
    op: "approve",
    join_request_id: request.join_request_id,
  });
  await qq.approveGroupJoinRequest("<group_openid>", request.member_openid, {
    op: "decline",
    join_request_id: request.join_request_id,
    reject_reason: "未通过入群验证",
    add_to_member_blacklist: true,
  });
}

const strategy = await qq.createGroupJoinApprovalStrategy({
  group_openids: ["<group_openid>"],
  is_enable: "on",
  remark: "活动白名单",
});
await qq.updateGroupJoinApprovalWhitelist(strategy.strategy_id, {
  op: "add",
  whitelist_users: ["1234567"],
});
await qq.executeGroupJoinApprovalStrategy(strategy.strategy_id);
```

单次禁言最多 10 个普通成员，不能操作群主、管理员或机器人。入群申请列表 `limit` 默认 20、最大 100；`next_cursor` 为空表示末页。创建策略时 `group_openids` 与 `group_ids` 二选一，最多 100 个群；白名单 QQ 号必须用字符串。

官方 wiki 的[群管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/group/manage/)目录页目前几乎为空；事件形状以 [用户申请加群事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html) 为准。

## 群消息、命令与提及

适配器支持 `GROUP_AT_MESSAGE_CREATE` 和 `GROUP_MESSAGE_CREATE`。QQ 侧开启普通群消息事件后，不带 @ 的群消息也会进入 Chat SDK message 路由；是否响应由 `onNewMessage(pattern)` 或订阅状态决定。

群内命令不要求 @，`/help` 和 `@机器人 /help` 都会进入 `onSlashCommand("/help")`。`onSlashCommand` 没有标准 `message.isMention` 字段，如需判断这次命令是否由 @ 触发，可以使用 QQ 专有辅助函数：

```ts
import { isQQMentioned } from "@amatsuka/chat-adapter-qq";

bot.onSlashCommand("/help", async (event) => {
  if (isQQMentioned(event)) {
    await event.channel.post("你是 @ 我触发的命令");
    return;
  }
  await event.channel.post("你是直接输入命令触发的");
});
```

## Raw Payload

QQ 官方字段会保留在 `message.raw` / `event.payload` 中。适配器只把跨平台能力映射到 Chat SDK 标准字段，平台特有数据不强行塞进标准模型。

Webhook 与 Socket Mode 会对 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 做入站去重：同一 `msg_id` 加上 `msg_seq` 和/或 `message_scene.ext` 里的 `msg_idx` 视为重复投递，只 ACK、不再次进入 `processMessage` / slash。缓存有 TTL（默认 10 分钟）和容量上限。

`content` 为空或只有空白时，会尽量补全 Chat 可见文本：

- 语音附件的 `asr_refer_text`
- `message_type=3` 的 `ark_data`（标题/prompt/来源等；完整数据仍在 `raw.ark_data`）
- `message_type=101/102` 的嵌套 `msg_elements` 文本；抽不出文本时保持空字符串，原始结构仍在 `raw`

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
- QQ Embed 发送
- 群基本信息 / 机器人群内状态（官方白名单接口）
- 频道（guild/channel）管理与消息

`fetchMessages` / `fetchMessage` 直接调用适配器时仍读取本进程缓存，不是 QQ 服务端历史消息查询。适配器同时声明了 `persistThreadHistory = true`，因此通过 Chat SDK 运行时接收/发送的线程历史会写入所配置的 state adapter，可跨进程恢复（持久性取决于所选 state adapter；`state-memory` 本身只在内存中保存）。

OpenAPI 默认仍使用历史域名 `https://api.sgroup.qq.com` 与 `https://bots.qq.com/app/getAppAccessToken`，避免打断现有 IP 白名单。当前 wiki 使用 `https://api.bot.qq.com`；可设 `apiHost: "bot"`，或保留默认并依赖 `hostFallback` 在默认 token 主机不可达时切换。显式 `apiBaseUrl` / `tokenEndpoint` 始终优先。沙箱域名仍是 `https://sandbox.api.sgroup.qq.com`。

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
# 默认 true；不设置 shard 时按 /gateway/bot 推荐值自动分片
QQ_SOCKET_MODE_AUTO_SHARDING=true
# 未设置时默认包含 GROUP_AND_C2C_EVENT、INTERACTION、MESSAGE_AUDIT（与适配器默认 intents 一致）
QQ_SOCKET_MODE_INTENTS=
QQ_SOCKET_MODE_SHARD=0,1
QQ_SOCKET_MODE_URL=
```

测试 bot 支持：

- 私聊任意文本：回复 `echo: <文本>`
- `/help`：显示测试命令列表
- `/ping`、`/id`
- `/md`
- `/button`：测试回调按钮和带稳定 ID 的 LinkButton
- `/image`：发送 `test/images/amatsuka.jpeg`
- `/images`：一次传入两张 `test/images/amatsuka.jpeg`
- `/file`：通过 Chat SDK `files` 发送文本文件，可同时验证群文件接口
- `/chart`：发送带 caption 的 Table 和 Chart 降级文本
- `/jsx-image`：发送包含 base64 data URL 图片的 Card 消息（走 media）
- `/jsx-image-url`：发送包含外部 URL 图片的 Card 消息（走 Markdown，可交错排版）
- `/ark`：发送 QQ Ark 消息
- `/stream`：测试带固定 `msg_seq` 的 C2C 原生流式消息（群聊自动降级）
- `/wakeup`：在 C2C 中测试 `is_wakeup` 主动唤醒，并在终端打印异步接受状态
- `/reference [message_id]`：测试 QQ `message_reference`；不传 ID 时使用当前命令消息 ID
- `/mention`：@发送者测试 mentionUser
- `/mention-state`：测试 `/mention-state` 与 `@bot /mention-state` 的提及状态差异
- `普通消息测试`：测试群普通消息进入 `onNewMessage`，并输出 `isMention` 与 raw 提及状态

`MESSAGE_AUDIT_PASS` / `MESSAGE_AUDIT_REJECT` 会以 `[qq:audit]` 输出到终端。也可以绕过 Bot 路由直接测试 C2C 主动唤醒发送：

```bash
pnpm run test:c2c-proactive -- <openid> "测试消息"
```

该脚本调用 `postQQMessage(..., { isWakeup: true })`，并打印 HTTP 状态、异步业务码与 delivery status。

## 参考

- https://bot.q.qq.com/wiki/develop/api-v2/
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
- https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
- https://bot.q.qq.com/wiki/develop/api-v2/changelog.html
- https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html
