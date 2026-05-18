/**
 * Send a proactive (主动) C2C message without passive msg_id/msg_seq context.
 *
 * Required env (.env.local):
 *   QQ_APP_ID
 *   QQ_CLIENT_SECRET (or QQ_SECRET)
 *
 * Optional env:
 *   QQ_SANDBOX=true
 *   BOT_USERNAME
 *
 * Usage:
 *   pnpm run test:c2c-proactive -- <openid> [message]
 */
import { ChatError } from "chat";
import { createQQAdapter } from "@amatsuka/chat-adapter-qq";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    console.error(`[c2c-proactive] missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): { userOpenId: string; message?: string } {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const userOpenId = positional[0]?.trim();
  if (!userOpenId) {
    console.error("[c2c-proactive] usage: pnpm run test:c2c-proactive -- <openid> [message]");
    process.exit(1);
  }
  const message = positional.slice(1).join(" ").trim();
  return message ? { message, userOpenId } : { userOpenId };
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = optionalEnv(name);
  if (value === undefined) {
    return defaultValue;
  }
  return value !== "false" && value !== "0";
}

const appId = requireEnv("QQ_APP_ID");
const clientSecret = optionalEnv("QQ_CLIENT_SECRET") ?? optionalEnv("QQ_SECRET");
if (!clientSecret) {
  console.error("[c2c-proactive] missing required env: QQ_CLIENT_SECRET (or QQ_SECRET)");
  process.exit(1);
}

const { userOpenId, message: messageArg } = parseArgs(process.argv.slice(2));
const message =
  messageArg ?? `[主动消息测试] ${new Date().toISOString()}`;

const qq = createQQAdapter({
  appId,
  clientSecret,
  mode: "webhook",
  sandbox: envFlag("QQ_SANDBOX", false),
  userName: optionalEnv("BOT_USERNAME") ?? "qq-c2c-proactive-test",
});

const threadId = qq.encodeThreadId({ type: "c2c", userOpenId });

console.log("[c2c-proactive] sending proactive C2C message", {
  threadId,
  userOpenId,
  sandbox: envFlag("QQ_SANDBOX", false),
  messagePreview: message.length > 80 ? `${message.slice(0, 80)}…` : message,
});

try {
  const sent = await qq.postMessage(threadId, message);
  console.log("[c2c-proactive] success", {
    messageId: sent.id,
    threadId: sent.threadId,
  });
} catch (error) {
  if (error instanceof ChatError) {
    console.error("[c2c-proactive] failed", {
      code: error.code,
      message: error.message,
      cause: error.cause,
    });
  } else {
    console.error("[c2c-proactive] failed", error);
  }
  process.exit(1);
}
