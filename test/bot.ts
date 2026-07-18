import { readFile } from "node:fs/promises";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chart,
  Chat,
  ConsoleLogger,
  LinkButton,
  Table,
} from "chat";
import type { Attachment, Channel, Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createQQAdapter,
  isQQMentioned,
  QQ_INTENTS,
  type QQAdapterBaseConfig,
  type QQSocketModeOptions,
} from "@amatsuka/chat-adapter-qq";

type QQTestTarget = Channel | Thread;

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = optionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }
  return value !== "false" && value !== "0";
}

function envNumber(name: string): number | undefined {
  const value = optionalEnv(name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envShard(name: string): readonly [number, number] | undefined {
  const value = optionalEnv(name);
  if (!value) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  const id = parts[0];
  const count = parts[1];
  if (
    id === undefined ||
    count === undefined ||
    !Number.isInteger(id) ||
    !Number.isInteger(count) ||
    count <= 0
  ) {
    return undefined;
  }
  return [id, count];
}

function resolveQQMode(): "socket" | "webhook" {
  const value = optionalEnv("QQ_MODE")?.toLowerCase();
  return value === "socket" || value === "websocket" || value === "ws"
    ? "socket"
    : "webhook";
}

const botUserName = optionalEnv("BOT_USERNAME") ?? "qq-test-bot";
const qqClientSecret =
  optionalEnv("QQ_CLIENT_SECRET") ?? optionalEnv("QQ_SECRET") ?? "";
const qqMode = resolveQQMode();
const qqBotSecret = optionalEnv("QQ_BOT_SECRET");
const qqSocketModeIntents = envNumber("QQ_SOCKET_MODE_INTENTS")
  ?? (QQ_INTENTS.GROUP_AND_C2C_EVENT
    | QQ_INTENTS.INTERACTION
    | QQ_INTENTS.MESSAGE_AUDIT);
const qqSocketModeShard = envShard("QQ_SOCKET_MODE_SHARD");
const qqSocketModeUrl = optionalEnv("QQ_SOCKET_MODE_URL");
const qqDebugPayloads = envFlag("QQ_DEBUG_PAYLOADS", false);
const qqTestImagePath = new URL("./images/amatsuka.jpeg", import.meta.url);

const qqBaseConfig = {
  appId: optionalEnv("QQ_APP_ID") ?? "",
  clientSecret: qqClientSecret,
  requireAppIdHeader: envFlag("QQ_REQUIRE_APP_ID_HEADER", true),
  ...(qqDebugPayloads ? { logger: new ConsoleLogger("debug") } : {}),
  sandbox: envFlag("QQ_SANDBOX", false),
  strictWebhookEvents: envFlag("QQ_STRICT_WEBHOOK_EVENTS", false),
  userName: botUserName,
  verifySignature: envFlag("QQ_VERIFY_SIGNATURE", true),
  ...(qqBotSecret !== undefined ? { botSecret: qqBotSecret } : {}),
} satisfies QQAdapterBaseConfig;

const qqSocketModeOptions = {
  autoSharding: envFlag("QQ_SOCKET_MODE_AUTO_SHARDING", true),
  intents: qqSocketModeIntents,
  ...(qqSocketModeShard !== undefined ? { shard: qqSocketModeShard } : {}),
  ...(qqSocketModeUrl !== undefined ? { url: qqSocketModeUrl } : {}),
} satisfies QQSocketModeOptions;

const qq = createQQAdapter(
  qqMode === "socket"
    ? {
        ...qqBaseConfig,
        mode: "socket",
        socketMode: qqSocketModeOptions,
      }
    : {
        ...qqBaseConfig,
        mode: "webhook",
      },
);

export const testBot = new Chat({
  adapters: {
    qq,
  },
  state: createMemoryState(),
  userName: botUserName,
});

qq.onEvent(async (event) => {
  if (event.type === "MESSAGE_AUDIT_PASS" || event.type === "MESSAGE_AUDIT_REJECT") {
    console.log("[qq:audit]", event.type, {
      data: event.data,
      eventId: event.eventId,
      threadId: event.threadId,
    });
    return;
  }
  console.log("[qq:event]", event.type, event.data);
});

if (qqDebugPayloads) {
  qq.onEvent(async (event) => {
    console.log("[qq:raw-event]", JSON.stringify(event.payload, null, 2));
  });
}

testBot.onSlashCommand("/ping", async (event) => {
  await event.channel.post(`pong ${new Date().toISOString()}`);
});

testBot.onSlashCommand("/id", async (event) => {
  await event.channel.post(
    `threadId: ${event.channel.id}, userId: ${event.user.userId}`,
  );
});

testBot.onSlashCommand("/help", async (event) => {
  await event.channel.post([
    "QQ test bot commands:",
    "/ping /id /md /button",
    "/image /images /jsx-image /jsx-image-url",
    "/file /chart /ark /stream",
    "/wakeup /reference [message_id]",
    "/mention /mention-state",
  ].join("\n"));
});

testBot.onSlashCommand("/md", async (event) => {
  await event.channel.post({
    markdown: [
      "# 一号标题",
      "## 二号标题",
      "",
      "**加粗文字** 和 __下划线加粗__",
      "_斜体_ 和 *星号斜体*",
      "***加粗斜体***",
      "~~删除线~~",
      "",
      "[🔗腾讯网](https://www.qq.com)",
      "",
      "> 引用：青青子衿，悠悠我心",
      "> 第二行引用",
      "",
      "***",
      "",
      "无序列表：",
      "- 列表项 A",
      "- 列表项 B",
      "",
      "有序列表：",
      "1. 第一步",
      "2. 第二步",
      "",
      "嵌套列表：",
      "1. 一级",
      "    - 二级无序",
      "2. 另一项",
      "    1. 二级有序",
      "",
      `- time: ${new Date().toISOString()}`,
      "- adapter: @amatsuka/chat-adapter-qq",
    ].join("\n"),
  });
});

testBot.onSlashCommand("/button", async (event) => {
  await event.channel.post(
    Card({
      children: [
        CardText("Click a button to test QQ INTERACTION_CREATE."),
        Actions([
          Button({
            id: "qq_test_ok",
            label: "OK",
            style: "primary",
            value: "ok",
          }),
          LinkButton({
            id: "qq_test_docs",
            label: "Docs",
            url: "https://bot.q.qq.com/wiki/develop/api-v2/",
          }),
        ]),
      ],
      title: "QQ Button Test",
    }),
  );
});

testBot.onSlashCommand("/image", async (event) => {
  await postImageTest(event.channel);
});

testBot.onSlashCommand("/images", async (event) => {
  await postImagesTest(event.channel);
});

testBot.onSlashCommand("/file", async (event) => {
  await postFileTest(event.channel);
});

testBot.onSlashCommand("/chart", async (event) => {
  await postChartTest(event.channel);
});

testBot.onSlashCommand("/jsx-image", async (event) => {
  await postJsxImageTest(event.channel);
});

testBot.onSlashCommand("/jsx-image-url", async (event) => {
  await postJsxImageUrlTest(event.channel);
});

testBot.onSlashCommand("/ark", async (event) => {
  await postArkTest(event.channel);
});

testBot.onSlashCommand("/wakeup", async (event) => {
  if (!event.channel.isDM) {
    await event.channel.post("/wakeup 仅支持 C2C 私聊。");
    return;
  }

  const sent = await qq.postQQMessage(
    event.channel.id,
    `[主动唤醒测试] ${new Date().toISOString()}`,
    { isWakeup: true },
  );
  console.log("[qq:wakeup] sent", {
    asyncCode: sent.raw._chat_async_code,
    asyncMessage: sent.raw._chat_async_message,
    deliveryStatus: sent.raw._chat_delivery_status,
    httpStatus: sent.raw._chat_http_status,
    messageId: sent.id,
  });
});

testBot.onSlashCommand("/reference", async (event) => {
  const messageId = event.text.trim() || event.triggerId;
  if (!messageId) {
    await event.channel.post("用法：/reference <message_id>；当前事件没有可用 triggerId。");
    return;
  }

  const sent = await qq.postQQMessage(
    event.channel.id,
    `QQ message_reference test: ${new Date().toISOString()}`,
    {
      messageReference: {
        ignore_get_message_error: false,
        message_id: messageId,
      },
      passiveContext: false,
    },
  );
  console.log("[qq:reference] sent", {
    messageId: sent.id,
    referencedMessageId: messageId,
  });
});

testBot.onSlashCommand("/mention", async (event) => {
  await event.channel.post(
    ` mention test: ${event.channel.mentionUser(event.user.userId)}`,
  );
});

testBot.onSlashCommand("/mention-state", async (event) => {
  await event.channel.post(
    [
      `mentioned: ${isQQMentioned(event) ? "yes" : "no"}`,
      `channelId: ${event.channel.id}`,
      `command: ${event.command}`,
      `text: ${event.text || "(empty)"}`,
    ].join("\n"),
  );
});

testBot.onSlashCommand("/stream", async (event) => {
  console.log("!!!!!!!!!! /stream command triggered", {
    threadId: event.channel.id,
    isDM: event.channel.isDM,
  });

  async function* simulateStream() {
    const sentences = [
      "这是",
      "一条",
      "模拟的",
      "流式消息。",
      "\n\n",
      "它会",
      "逐段",
      "发送",
      "到",
      "QQ",
      "客户端。",
      "\n\n",
      "你可以",
      "看到",
      "打字机",
      "效果。",
      "\n\n",
      `时间: ${new Date().toISOString()}`,
    ];
    for (const sentence of sentences) {
      yield sentence;
      // 模拟 LLM 逐字输出的延迟
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("!!!!!!!!!! /stream calling channel.post() with async iterable");
  const result = await event.channel.post(simulateStream());
  console.log("!!!!!!!!!! /stream channel.post() returned", {
    messageId: result.id,
  });
});

testBot.onNewMessage(/^普通消息测试(?:\s+(.+))?$/i, async (thread, message) => {
  console.log("!!!!!!!!!! onNewMessage", {
    isMention: message.isMention,
    mentioned: isQQMentioned(message),
    text: message.text,
    threadId: thread.id,
  });
  if (qqDebugPayloads) {
    console.log("[qq:raw-message]", JSON.stringify(message.raw, null, 2));
  }

  await thread.post(
    [
      "普通群消息已触发 onNewMessage",
      `isMention: ${message.isMention === true ? "yes" : "no"}`,
      `mentioned(raw): ${isQQMentioned(message) ? "yes" : "no"}`,
      `threadId: ${thread.id}`,
    ].join("\n"),
  );
});

testBot.onDirectMessage(async (thread, message) => {
  console.log("!!!!!!!!!! onDirectMessage", {
    isMention: message.isMention,
    mentioned: isQQMentioned(message),
    text: message.text,
    threadId: thread.id,
  });
  if (qqDebugPayloads) {
    console.log("[qq:raw-message]", JSON.stringify(message.raw, null, 2));
  }

  await thread.post(`echo: ${message.text}`);
});

testBot.onSubscribedMessage(async (thread, message) => {
  console.log("!!!!!!!!!! onSubscribedMessage", {
    isMention: message.isMention,
    mentioned: isQQMentioned(message),
    text: message.text,
    threadId: thread.id,
  });
  if (qqDebugPayloads) {
    console.log("[qq:raw-message]", JSON.stringify(message.raw, null, 2));
  }

  await thread.post(`echo: ${message.text}`);
});

testBot.onAction("qq_test_ok", async (event) => {
  await event.thread?.post(`button clicked: ${event.value ?? event.actionId}`);
});

async function postImageTest(thread: QQTestTarget): Promise<void> {
  await thread.post({
    attachments: [await readTestImageAttachment()],
    raw: `QQ media image test: ${new Date().toISOString()}`,
  });
}

async function postImagesTest(thread: QQTestTarget): Promise<void> {
  await thread.post({
    attachments: [
      await readTestImageAttachment(),
      {
        type: "image",
        url: "https://1839696043.v.123pan.cn/1839696043/36371456",
      },
    ],
    raw: "",
  });
}

async function postFileTest(thread: QQTestTarget): Promise<void> {
  const timestamp = new Date().toISOString();
  await thread.post({
    files: [
      {
        data: Buffer.from([
          "@amatsuka/chat-adapter-qq file upload test",
          `threadId: ${thread.id}`,
          `timestamp: ${timestamp}`,
          "",
        ].join("\n")),
        filename: "qq-chat-sdk-file-test.txt",
        mimeType: "text/plain; charset=utf-8",
      },
    ],
    raw: `QQ Chat SDK files test: ${timestamp}`,
  });
}

async function postChartTest(thread: QQTestTarget): Promise<void> {
  await thread.post(Card({
    children: [
      CardText("Chat SDK 4.34 Table caption + Chart fallback test"),
      Table({
        caption: "QQ adapter capability status",
        headers: ["Capability", "Status"],
        rows: [
          ["Chat SDK files", "supported"],
          ["Group files", "supported"],
          ["Chart fallback", "supported"],
        ],
      }),
      Chart({
        title: "QQ adapter test coverage",
        chart: {
          segments: [
            { label: "Protocol", value: 60 },
            { label: "Rich media", value: 25 },
            { label: "Gateway", value: 15 },
          ],
          type: "pie",
        },
      }),
    ],
    title: "QQ Rich Card Test",
  }));
}

async function postJsxImageTest(thread: QQTestTarget): Promise<void> {
  await thread.post(
    Card({
      children: [
        CardText("QQ JSX image test"),
        {
          alt: "Amatsuka",
          type: "image",
          url: await readTestImageDataUrl(),
        },
      ],
      title: "QQ JSX Card",
    }),
  );
}

async function postJsxImageUrlTest(thread: QQTestTarget): Promise<void> {
  await thread.post(
    Card({
      children: [
        CardText("文字在图片上方"),
        {
          alt: "External Image",
          type: "image",
          url: "https://1839696043.v.123pan.cn/1839696043/36371456",
        },
        CardText("文字在图片下方"),
      ],
      title: "QQ JSX URL Image",
    }),
  );
}

async function postArkTest(thread: QQTestTarget): Promise<void> {
  await qq.postArk(thread.id, {
    kv: [
      {
        key: "#DESC#",
        value: "机器人订阅消息",
      },
      {
        key: "#PROMPT#",
        value: "QQ Test Bot",
      },
      {
        key: "#LIST#",
        obj: [
          {
            obj_kv: [
              {
                key: "desc",
                value: "QQ Ark Test",
              },
            ],
          },
          {
            obj_kv: [
              {
                key: "desc",
                value: `time: ${new Date().toISOString()}`,
              },
            ],
          },
          {
            obj_kv: [
              {
                key: "desc",
                value: "@amatsuka/chat-adapter-qq",
              },
            ],
          },
        ],
      },
    ],
    template_id: 23,
  });
}

let _testImageBuffer: Buffer | undefined;

async function getTestImageBuffer(): Promise<Buffer> {
  if (!_testImageBuffer) {
    _testImageBuffer = await readFile(qqTestImagePath);
  }
  return _testImageBuffer;
}

async function readTestImageAttachment(): Promise<Attachment> {
  const data = await getTestImageBuffer();
  return {
    data,
    mimeType: "image/jpeg",
    name: "amatsuka.jpeg",
    type: "image",
  };
}

async function readTestImageDataUrl(): Promise<string> {
  const data = await getTestImageBuffer();
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}
