import { readFile } from "node:fs/promises";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  ConsoleLogger,
  LinkButton,
} from "chat";
import type { Attachment, Channel, Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createQQAdapter,
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
const qqSocketModeIntents = envNumber("QQ_SOCKET_MODE_INTENTS");
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
  ...(qqSocketModeIntents !== undefined
    ? { intents: qqSocketModeIntents }
    : {}),
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

testBot.onSlashCommand("/jsx-image", async (event) => {
  await postJsxImageTest(event.channel);
});

testBot.onSlashCommand("/jsx-image-url", async (event) => {
  await postJsxImageUrlTest(event.channel);
});

testBot.onSlashCommand("/ark", async (event) => {
  await postArkTest(event.channel);
});

testBot.onSlashCommand("/mention", async (event) => {
  await event.channel.post(
    ` mention test: ${event.channel.mentionUser(event.user.userId)}`,
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

testBot.onDirectMessage(async (thread, message) => {
  console.log("!!!!!!!!!! onDirectMessage", {
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
