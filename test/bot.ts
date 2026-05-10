import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  LinkButton,
} from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createQQAdapter } from "@amatsuka/chat-adapter-qq";

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
  const [id, count] = value.split(",").map((part) => Number(part.trim()));
  if (!Number.isInteger(id) || !Number.isInteger(count) || count <= 0) {
    return undefined;
  }
  return [id, count];
}

function resolveQQMode(): "socket" | "webhook" {
  const value = optionalEnv("QQ_MODE")?.toLowerCase();
  return value === "socket" || value === "websocket" || value === "ws" ? "socket" : "webhook";
}

const botUserName = optionalEnv("BOT_USERNAME") ?? "qq-test-bot";
const qqClientSecret =
  optionalEnv("QQ_CLIENT_SECRET") ?? optionalEnv("QQ_SECRET") ?? "";
const qqMode = resolveQQMode();

const qq = createQQAdapter({
  appId: optionalEnv("QQ_APP_ID") ?? "",
  botSecret: optionalEnv("QQ_BOT_SECRET"),
  botUserId: optionalEnv("QQ_BOT_USER_ID"),
  clientSecret: qqClientSecret,
  mode: qqMode,
  requireAppIdHeader: envFlag("QQ_REQUIRE_APP_ID_HEADER", true),
  sandbox: envFlag("QQ_SANDBOX", false),
  socketMode: {
    intents: envNumber("QQ_SOCKET_MODE_INTENTS"),
    shard: envShard("QQ_SOCKET_MODE_SHARD"),
    url: optionalEnv("QQ_SOCKET_MODE_URL"),
  },
  strictWebhookEvents: envFlag("QQ_STRICT_WEBHOOK_EVENTS", false),
  userName: botUserName,
  verifySignature: envFlag("QQ_VERIFY_SIGNATURE", true),
});

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

testBot.onSlashCommand("/ping", async (event) => {
  await event.channel.post(`pong ${new Date().toISOString()}`);
});

testBot.onSlashCommand("/md", async (event) => {
  await event.channel.post({
    markdown: [
      "# QQ Markdown OK",
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

testBot.onDirectMessage(async (thread, message) => {
  await thread.post(`echo: ${message.text}`);
});

testBot.onSubscribedMessage(async (thread, message) => {
  await thread.post(`echo: ${message.text}`);
});

testBot.onAction("qq_test_ok", async (event) => {
  await event.thread?.post(`button clicked: ${event.value ?? event.actionId}`);
});
