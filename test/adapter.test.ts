import type { ChatInstance, Logger } from "chat";
import { Actions, Button, Card, CardLink, CardText, Chart, Divider, Field, Fields, Image, LinkButton, Section, Table } from "chat";
import { QQAdapter, isQQMentioned, DEFAULT_GATEWAY_INTENTS, DEFAULT_TOKEN_ENDPOINT, BOT_TOKEN_ENDPOINT, BOT_API_BASE_URL } from "@amatsuka/chat-adapter-qq";
import type { QQRawMessage, QQSocketModeAdapterConfig, QQWebhookAdapterConfig } from "@amatsuka/chat-adapter-qq";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const APP_ID = "11111111";
const BOT_SECRET = "DG5g3B4j9X2KOErG";
const ED25519_PRIVATE_KEY_DER_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

type SocketModeMessageData = ArrayBuffer | string;
type SocketModeEvent = CloseEvent | Event | MessageEvent<SocketModeMessageData>;
type SocketModeListener =
  | ((event: CloseEvent) => void)
  | ((event: Event) => void)
  | ((event: MessageEvent<SocketModeMessageData>) => void);

type TestQQAdapterConfig =
  | (Partial<Omit<QQSocketModeAdapterConfig, "appId" | "clientSecret" | "mode">> & { mode: "socket" })
  | Partial<Omit<QQWebhookAdapterConfig, "appId" | "clientSecret">>;

function createAdapter(config: TestQQAdapterConfig = {}): QQAdapter {
  const baseConfig = {
    appId: APP_ID,
    clientSecret: BOT_SECRET,
    logger: createSilentLogger(),
    verifySignature: false,
  };
  return new QQAdapter({
    ...baseConfig,
    ...config,
  });
}

function createSilentLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  };
  return logger;
}

function createBotSeed(secret: string): Uint8Array {
  const source = new TextEncoder().encode(secret);
  const seed = new Uint8Array(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = source[index % source.length]!;
  }
  return seed;
}

async function signQQMessage(secret: string, message: string): Promise<string> {
  const seed = createBotSeed(secret);
  const pkcs8Der = new Uint8Array(ED25519_PRIVATE_KEY_DER_PREFIX.length + seed.length);
  pkcs8Der.set(ED25519_PRIVATE_KEY_DER_PREFIX, 0);
  pkcs8Der.set(seed, ED25519_PRIVATE_KEY_DER_PREFIX.length);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    "Ed25519",
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(body: string, options: { signature?: string; timestamp?: string } = {}): Promise<Request> {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = options.signature ?? await signQQMessage(BOT_SECRET, `${timestamp}${body}`);
  return new Request("https://example.test/webhooks/qq", {
    body,
    headers: {
      "X-Bot-Appid": APP_ID,
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    method: "POST",
  });
}

async function initializeWithProcessSpy(adapter: QQAdapter) {
  const processMessage = mock.fn();
  await adapter.initialize({ processMessage } as unknown as ChatInstance);
  return processMessage;
}

async function initializeWithProcessActionSpy(adapter: QQAdapter) {
  const processAction = mock.fn();
  await adapter.initialize({ processAction } as unknown as ChatInstance);
  return processAction;
}

async function initializeWithProcessSlashCommandSpy(adapter: QQAdapter) {
  const processMessage = mock.fn();
  const processSlashCommand = mock.fn();
  await adapter.initialize({ processMessage, processSlashCommand } as unknown as ChatInstance);
  return { processMessage, processSlashCommand };
}

const _fetch = globalThis.fetch;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = _fetch;
});

class MockSocketModeSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: SocketModeEvent) => void>>();

  addEventListener(type: "message", listener: (event: MessageEvent<SocketModeMessageData>) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error" | "open", listener: (event: Event) => void): void;
  addEventListener(
    type: "close" | "error" | "message" | "open",
    listener: SocketModeListener,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: SocketModeEvent) => void);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = ""): void {
    this.emitClose(code, reason);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: "close" | "error" | "message" | "open", event: SocketModeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitClose(code: number, reason = ""): void {
    this.emit("close", { code, reason } as CloseEvent);
  }
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function assertMatchObject(actual: unknown, expected: Record<string, unknown>, path = ""): void {
  for (const key of Object.keys(expected)) {
    const currentPath = path ? `${path}.${key}` : key;
    const expectedValue = expected[key];
    const actualValue = (actual as Record<string, unknown>)[key];

    if (expectedValue !== null && typeof expectedValue === "object" && !Array.isArray(expectedValue)) {
      assertMatchObject(actualValue, expectedValue as Record<string, unknown>, currentPath);
    } else {
      assert.deepStrictEqual(actualValue, expectedValue, currentPath);
    }
  }
}

function requestJsonBody(call: { arguments: unknown[] }): Record<string, unknown> {
  return JSON.parse(String((call.arguments[1] as RequestInit | undefined)?.body ?? ""));
}

function fetchCalls(
  fetchMock: { mock: { calls: Array<{ arguments: unknown[] }> } },
  includes: string,
): Array<{ arguments: unknown[] }> {
  return fetchMock.mock.calls.filter((call) => String(call.arguments[0]).includes(includes));
}

async function dispatchC2CMessage(
  adapter: QQAdapter,
  data: Record<string, unknown> = {},
  envelope: Record<string, unknown> = {},
): Promise<Response> {
  return adapter.handleWebhook(
    new Request("https://example.test/webhooks/qq", {
      body: JSON.stringify({
        d: {
          author: {
            user_openid: "user-openid",
          },
          content: "hello",
          id: "message-1",
          timestamp: "2026-05-09T12:00:00+08:00",
          ...data,
        },
        id: "event-1",
        op: 0,
        s: 7,
        t: "C2C_MESSAGE_CREATE",
        ...envelope,
      }),
      headers: {
        "X-Bot-Appid": APP_ID,
      },
      method: "POST",
    }),
  );
}

describe("QQAdapter webhook security", () => {
  it("returns the official validation challenge signature", async () => {
    const adapter = createAdapter({
      botSecret: BOT_SECRET,
      verifySignature: true,
    });
    const body = JSON.stringify({
      d: {
        event_ts: "1725442341",
        plain_token: "Arq0D5A61EgUu4OxUvOp",
      },
      op: 13,
    });

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body,
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.deepStrictEqual(await response.json(), {
      plain_token: "Arq0D5A61EgUu4OxUvOp",
      signature:
        "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
    });
  });

  it("accepts a correctly signed webhook request", async () => {
    const adapter = createAdapter({
      botSecret: BOT_SECRET,
      verifySignature: true,
    });
    const body = JSON.stringify({
      d: {
        ignored: true,
      },
      id: "event-1",
      op: 0,
      s: 42,
      t: "READY",
    });

    const response = await adapter.handleWebhook(await signedRequest(body));

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      d: {
        seq: 42,
      },
      op: 12,
    });
  });

  it("rejects an invalid webhook signature", async () => {
    const adapter = createAdapter({
      botSecret: BOT_SECRET,
      verifySignature: true,
    });
    const body = JSON.stringify({
      d: {},
      id: "event-1",
      op: 0,
      t: "READY",
    });

    const response = await adapter.handleWebhook(
      await signedRequest(body, {
        signature: "00".repeat(64),
      }),
    );

    assert.strictEqual(response.status, 401);
    assertMatchObject(await response.json(), {
      error: {
        code: "INVALID_SIGNATURE",
      },
    });
  });

  it("returns 400 for invalid JSON after signature verification", async () => {
    const adapter = createAdapter({
      botSecret: BOT_SECRET,
      verifySignature: true,
    });

    const response = await adapter.handleWebhook(await signedRequest("{not-json"));

    assert.strictEqual(response.status, 400);
    assertMatchObject(await response.json(), {
      error: {
        code: "INVALID_JSON",
      },
    });
  });
});

describe("QQAdapter webhook events", () => {
  it("dispatches C2C message events to Chat SDK", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              user_openid: "user-openid",
            },
            content: "hello",
            id: "message-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 7,
          t: "C2C_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 1);
    assert.strictEqual(processMessage.mock.calls[0]?.arguments[1], "qq:c2c/user-openid");
    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      id: "message-1",
      text: "hello",
      threadId: "qq:c2c/user-openid",
    });
  });

  it("dispatches group message events with group thread and member author", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              member_openid: "member-openid",
            },
            content: "hello group",
            group_openid: "group-openid",
            id: "message-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 7,
          t: "GROUP_AT_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 1);
    assert.strictEqual(processMessage.mock.calls[0]?.arguments[1], "qq:group/group-openid");
    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      author: {
        isMe: false,
        userId: "member-openid",
      },
      id: "message-1",
      isMention: true,
      raw: {
        _chat_event_type: "GROUP_AT_MESSAGE_CREATE",
        _chat_is_mention: true,
      },
      text: "hello group",
      threadId: "qq:group/group-openid",
    });
    assert.strictEqual(isQQMentioned(processMessage.mock.calls[0]?.arguments[2]), true);
  });

  it("dispatches non-mention group message events as regular messages", async () => {
    const adapter = createAdapter({
      strictWebhookEvents: true,
    });
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              member_openid: "member-openid",
            },
            content: "hello without mention",
            group_openid: "group-openid",
            id: "message-1",
            mentions: [
              {
                is_you: false,
                member_openid: "other-member-openid",
                nickname: "Other",
              },
            ],
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 7,
          t: "GROUP_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 1);
    assert.strictEqual(processSlashCommand.mock.callCount(), 0);
    const message = processMessage.mock.calls[0]?.arguments[2];
    const raw = (message as { raw: QQRawMessage }).raw;
    assertMatchObject(message, {
      id: "message-1",
      isMention: false,
      raw: {
        _chat_event_type: "GROUP_MESSAGE_CREATE",
        _chat_is_mention: false,
        mentions: [
          {
            is_you: false,
            member_openid: "other-member-openid",
            nickname: "Other",
          },
        ],
      },
      text: "hello without mention",
      threadId: "qq:group/group-openid",
    });
    assert.strictEqual(raw.mentions?.[0]?.nickname, "Other");
    assert.strictEqual(isQQMentioned(message), false);
  });

  it("normalizes QQ quoted message data from message scene elements", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              user_openid: "user-openid",
            },
            content: "quoted reply",
            id: "message-2",
            message_scene: {
              ext: [
                "",
                "ref_msg_idx=REFIDX_SOURCE",
                "msg_idx=REFIDX_CURRENT",
              ],
              source: "default",
            },
            message_type: 103,
            msg_elements: [
              {
                content: "source message",
                message_type: 103,
                msg_idx: "REFIDX_SOURCE",
              },
            ],
            timestamp: "2026-05-11T02:06:48+08:00",
          },
          id: "event-1",
          op: 0,
          s: 7,
          t: "C2C_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 1);
    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      raw: {
        _chat_quoted_message: {
          content: "source message",
          messageType: 103,
          msgIdx: "REFIDX_SOURCE",
        },
      },
      text: "quoted reply",
    });
  });

  it("dedupes redelivered inbound messages with the same msg_id and msg_idx", async () => {
    const adapter = createAdapter();
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);
    const body = {
      d: {
        author: { user_openid: "user-openid" },
        content: "hello",
        id: "message-dup",
        message_scene: {
          ext: ["msg_idx=REFIDX_CURRENT"],
        },
        msg_seq: 8,
        timestamp: "2026-05-09T12:00:00+08:00",
      },
      id: "event-1",
      op: 0,
      s: 7,
      t: "C2C_MESSAGE_CREATE",
    };

    const first = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify(body),
        headers: { "X-Bot-Appid": APP_ID },
        method: "POST",
      }),
    );
    const second = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({ ...body, id: "event-2", s: 8 }),
        headers: { "X-Bot-Appid": APP_ID },
        method: "POST",
      }),
    );

    assert.strictEqual(first.status, 200);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 1);
    assert.strictEqual(processSlashCommand.mock.callCount(), 0);
  });

  it("does not treat a different msg_idx as a duplicate of the same msg_id", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response1 = await dispatchC2CMessage(adapter, {
      id: "message-shared",
      message_scene: { ext: ["msg_idx=IDX_A"] },
    });
    const response2 = await dispatchC2CMessage(adapter, {
      id: "message-shared",
      message_scene: { ext: ["msg_idx=IDX_B"] },
    }, { id: "event-2", s: 8 });

    assert.strictEqual(response1.status, 200);
    assert.strictEqual(response2.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 2);
  });

  it("dedupes redelivered slash commands without dispatching twice", async () => {
    const adapter = createAdapter();
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);

    const payload = {
      d: {
        author: { user_openid: "user-openid" },
        content: "/ping",
        id: "slash-1",
        timestamp: "2026-05-09T12:00:00+08:00",
      },
      id: "event-1",
      op: 0,
      s: 7,
      t: "C2C_MESSAGE_CREATE",
    };
    await adapter.handleWebhook(new Request("https://example.test/webhooks/qq", {
      body: JSON.stringify(payload),
      headers: { "X-Bot-Appid": APP_ID },
      method: "POST",
    }));
    await adapter.handleWebhook(new Request("https://example.test/webhooks/qq", {
      body: JSON.stringify({ ...payload, s: 8 }),
      headers: { "X-Bot-Appid": APP_ID },
      method: "POST",
    }));

    assert.strictEqual(processSlashCommand.mock.callCount(), 1);
    assert.strictEqual(processMessage.mock.callCount(), 0);
  });

  it("surfaces ARK card metadata when inbound content is empty", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await dispatchC2CMessage(adapter, {
      ark_data: {
        ark_name: "小程序",
        ark_type: "miniapp",
        fields: {
          source: "学习助手",
          title: "快来完成今日学习打卡",
        },
        prompt: "[每日打卡]快来完成今日学习打卡",
      },
      content: "",
      message_type: 3,
    });

    assert.strictEqual(response.status, 200);
    const message = processMessage.mock.calls[0]?.arguments[2] as { raw: QQRawMessage; text: string };
    assert.strictEqual(message.raw.message_type, 3);
    assert.strictEqual(message.raw.ark_data?.ark_type, "miniapp");
    assert.match(message.text, /小程序/);
    assert.match(message.text, /每日打卡|快来完成今日学习打卡/);
  });

  it("uses voice asr_refer_text when inbound content is empty", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    await dispatchC2CMessage(adapter, {
      attachments: [
        {
          asr_refer_text: "语音转写结果",
          content_type: "voice",
          url: "https://example.test/voice.silk",
        },
      ],
      content: "   ",
    });

    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      text: "语音转写结果",
    });
  });

  it("collects nested msg_elements text for chat history payloads", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    await dispatchC2CMessage(adapter, {
      content: "",
      message_type: 102,
      msg_elements: [
        { content: "昨天的计划", message_type: 0 },
        {
          message_type: 101,
          msg_elements: [{ content: "并行补充", message_type: 0 }],
        },
      ],
    });

    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      raw: { message_type: 102 },
      text: "昨天的计划\n并行补充",
    });
  });

  it("ACKs known non-message events without dispatching messages", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            openid: "user-openid",
          },
          id: "event-1",
          op: 0,
          s: 8,
          t: "C2C_MSG_RECEIVE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 0);
    assert.deepStrictEqual(await response.json(), {
      d: {
        seq: 8,
      },
      op: 12,
    });
  });

  it("dispatches known QQ platform events to adapter onEvent handlers", async () => {
    const onEvent = mock.fn();
    const adapter = createAdapter();
    adapter.onEvent("FRIEND_ADD", onEvent);
    await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            openid: "user-openid",
          },
          id: "event-1",
          op: 0,
          s: 8,
          t: "FRIEND_ADD",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(onEvent.mock.callCount(), 1);
    assertMatchObject(onEvent.mock.calls[0]?.arguments[0], {
      data: {
        openid: "user-openid",
      },
      eventId: "event-1",
      type: "FRIEND_ADD",
    });
  });

  it("supports catch-all QQ platform event handlers and unsubscribe", async () => {
    const onEvent = mock.fn();
    const adapter = createAdapter();
    const unsubscribe = adapter.onEvent(onEvent);
    await initializeWithProcessSpy(adapter);

    const request = () =>
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            openid: "user-openid",
          },
          id: "event-1",
          op: 0,
          s: 8,
          t: "FRIEND_DEL",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      });

    await adapter.handleWebhook(request());
    unsubscribe();
    await adapter.handleWebhook(request());

    assert.strictEqual(onEvent.mock.callCount(), 1);
  });

  it("returns 400 for unknown events in strict mode", async () => {
    const adapter = createAdapter({
      strictWebhookEvents: true,
    });
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {},
          id: "event-1",
          op: 0,
          s: 9,
          t: "UNKNOWN_EVENT",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 400);
    assert.strictEqual(processMessage.mock.callCount(), 0);
    assertMatchObject(await response.json(), {
      error: {
        code: "UNSUPPORTED_EVENT",
      },
    });
  });

  it("dispatches slash-looking QQ messages to Chat SDK slash commands", async () => {
    const adapter = createAdapter();
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              user_openid: "user-openid",
            },
            content: "/button extra args",
            id: "message-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 12,
          t: "C2C_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 0);
    assert.strictEqual(processSlashCommand.mock.callCount(), 1);
    assertMatchObject(processSlashCommand.mock.calls[0]?.arguments[0], {
      channelId: "qq:c2c/user-openid",
      command: "/button",
      raw: {
        _chat_event_type: "C2C_MESSAGE_CREATE",
        _chat_is_mention: true,
      },
      text: "extra args",
      triggerId: "message-1",
      user: {
        userId: "user-openid",
      },
    });
    assert.strictEqual(isQQMentioned(processSlashCommand.mock.calls[0]?.arguments[0]), true);
  });

  it("dispatches non-mention group slash commands without regular message dispatch", async () => {
    const adapter = createAdapter();
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              member_openid: "member-openid",
            },
            content: "/help topic",
            group_openid: "group-openid",
            id: "message-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 12,
          t: "GROUP_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 0);
    assert.strictEqual(processSlashCommand.mock.callCount(), 1);
    assertMatchObject(processSlashCommand.mock.calls[0]?.arguments[0], {
      channelId: "qq:group/group-openid",
      command: "/help",
      raw: {
        _chat_event_type: "GROUP_MESSAGE_CREATE",
        _chat_is_mention: false,
      },
      text: "topic",
      triggerId: "message-1",
      user: {
        userId: "member-openid",
      },
    });
    assert.strictEqual(isQQMentioned(processSlashCommand.mock.calls[0]?.arguments[0]), false);
  });

  it("dispatches mention-prefixed group slash commands", async () => {
    const adapter = createAdapter();
    const { processMessage, processSlashCommand } = await initializeWithProcessSlashCommandSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              member_openid: "member-openid",
            },
            content: "@qq-bot /help topic",
            group_openid: "group-openid",
            id: "message-1",
            mentions: [
              {
                is_you: true,
                member_openid: "bot-member-openid",
                nickname: "qq-bot",
              },
            ],
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-1",
          op: 0,
          s: 12,
          t: "GROUP_AT_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processMessage.mock.callCount(), 0);
    assert.strictEqual(processSlashCommand.mock.callCount(), 1);
    assertMatchObject(processSlashCommand.mock.calls[0]?.arguments[0], {
      channelId: "qq:group/group-openid",
      command: "/help",
      raw: {
        _chat_event_type: "GROUP_AT_MESSAGE_CREATE",
        _chat_is_mention: true,
        mentions: [
          {
            is_you: true,
            member_openid: "bot-member-openid",
            nickname: "qq-bot",
          },
        ],
      },
      text: "topic",
      triggerId: "message-1",
      user: {
        userId: "member-openid",
      },
    });
    assert.strictEqual(isQQMentioned(processSlashCommand.mock.calls[0]?.arguments[0]), true);
  });
});

describe("QQAdapter interaction events", () => {
  it("dispatches QQ button interactions to Chat SDK actions", async () => {
    const adapter = createAdapter({
      acknowledgeInteractions: false,
    });
    const processAction = await initializeWithProcessActionSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            data: {
              resolved: {
                button_data: "order-123",
                button_id: "approve",
                message_id: "message-1",
                user_id: "user-openid",
              },
            },
            chat_type: 2,
            id: "interaction-1",
          },
          id: "event-1",
          op: 0,
          s: 11,
          t: "INTERACTION_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processAction.mock.callCount(), 1);
    assertMatchObject(processAction.mock.calls[0]?.arguments[0], {
      actionId: "approve",
      messageId: "message-1",
      threadId: "qq:c2c/user-openid",
      triggerId: "interaction-1",
      value: "order-123",
      user: {
        userId: "user-openid",
      },
    });
  });

  it("ACKs QQ button interactions before dispatching Chat SDK actions", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const order: string[] = [];
    const processAction = mock.fn(() => {
      order.push("action");
    });
    await adapter.initialize({ processAction } as unknown as ChatInstance);
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/interactions/interaction-1") {
        order.push("ack");
        return new Response(null, {
          status: 204,
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            chat_type: 2,
            data: {
              resolved: {
                button_data: "order-123",
                button_id: "approve",
                user_id: "user-openid",
              },
            },
            id: "interaction-1",
          },
          id: "event-1",
          op: 0,
          t: "INTERACTION_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(order, ["ack", "action"]);
  });

  it("dispatches group button interactions with member author and group thread", async () => {
    const adapter = createAdapter({
      acknowledgeInteractions: false,
    });
    const processAction = await initializeWithProcessActionSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            chat_type: 1,
            data: {
              resolved: {
                button_data: "order-123",
                button_id: "approve",
              },
            },
            group_member_openid: "member-openid",
            group_openid: "group-openid",
            id: "interaction-1",
            scene: "group",
          },
          id: "event-1",
          op: 0,
          s: 11,
          t: "INTERACTION_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(processAction.mock.callCount(), 1);
    assertMatchObject(processAction.mock.calls[0]?.arguments[0], {
      actionId: "approve",
      threadId: "qq:group/group-openid",
      user: {
        isMe: false,
        userId: "member-openid",
      },
      value: "order-123",
    });
  });

  it("dispatches quick-menu interactions using feature_id", async () => {
    const adapter = createAdapter({ acknowledgeInteractions: false });
    const processAction = await initializeWithProcessActionSpy(adapter);

    await adapter.handleWebhook(new Request("https://example.test/webhooks/qq", {
      body: JSON.stringify({
        d: {
          chat_type: 2,
          data: {
            resolved: {
              feature_id: "quick-menu-weather",
              message_id: "message-quick-menu",
              user_id: "user-openid",
            },
            type: 12,
          },
          id: "interaction-quick-menu",
        },
        id: "event-quick-menu",
        op: 0,
        t: "INTERACTION_CREATE",
      }),
      headers: { "X-Bot-Appid": APP_ID },
      method: "POST",
    }));

    assert.strictEqual(processAction.mock.callCount(), 1);
    assertMatchObject(processAction.mock.calls[0]?.arguments[0], {
      actionId: "quick-menu-weather",
      messageId: "message-quick-menu",
      threadId: "qq:c2c/user-openid",
    });
  });

  it("does not misclassify guild interactions as C2C", async () => {
    const adapter = createAdapter({ acknowledgeInteractions: false });
    const processAction = await initializeWithProcessActionSpy(adapter);

    await adapter.handleWebhook(new Request("https://example.test/webhooks/qq", {
      body: JSON.stringify({
        d: {
          chat_type: 0,
          data: { resolved: { button_id: "guild-action", user_id: "guild-user" } },
          id: "guild-interaction",
          scene: "guild",
        },
        op: 0,
        t: "INTERACTION_CREATE",
      }),
      method: "POST",
    }));

    assert.strictEqual(processAction.mock.callCount(), 0);
  });
});

describe("QQAdapter outbound rich messages", () => {
  it("marks locally posted messages as bot-authored self messages", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", "hello");
    const message = await adapter.fetchMessage("qq:c2c/user-openid", "sent-message-1");

    assertMatchObject(message, {
      author: {
        isBot: true,
        isMe: true,
        userId: APP_ID,
        userName: "qq-bot",
      },
      text: "hello",
    });
  });

  it("sends Chat SDK markdown as QQ native markdown", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      markdown: "**hello**",
    });

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      markdown: {
        content: "**hello**",
      },
      msg_type: 2,
    });
  });

  it("adds QQ markdown image dimensions to external markdown images", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      markdown: "![sample](https://example.test/image.png)",
    });

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      markdown: {
        content: "![sample #208px #320px](https://example.test/image.png)",
      },
      msg_type: 2,
    });
  });

  it("rejects non-external markdown images", async () => {
    const adapter = createAdapter();

    await assert.rejects(
      adapter.postMessage("qq:c2c/user-openid", {
        markdown: "![sample](data:image/png;base64,aW1hZ2U=)",
      }),
      /QQ markdown images require external HTTP\(S\) URLs/,
    );
  });

  it("sends URL image attachments through QQ media flow", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        return Response.json({
          file_info: "media-file-info",
          file_uuid: "media-file-uuid",
          ttl: 3600,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      attachments: [
        {
          type: "image",
          url: "https://example.test/image.png",
        },
      ],
      raw: "image caption",
    });

    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/files")[0]!), {
      file_type: 1,
      srv_send_msg: false,
      url: "https://example.test/image.png",
    });
    const messageBodies = fetchCalls(fetchMock, "/messages").map(requestJsonBody);
    assert.deepStrictEqual(messageBodies, [
      {
        content: "image caption",
        msg_type: 0,
      },
      {
        media: {
          file_info: "media-file-info",
          file_uuid: "media-file-uuid",
          ttl: 3600,
        },
        msg_type: 7,
      },
    ]);
  });

  it("sends binary image attachments through QQ media file_data", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        return Response.json({
          file_info: "media-file-info",
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      attachments: [
        {
          data: Buffer.from("image-bytes"),
          type: "image",
        },
      ],
      raw: "image caption",
    });

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      file_data: Buffer.from("image-bytes").toString("base64"),
      file_type: 1,
      srv_send_msg: false,
    });
  });

  it("uploads Chat SDK files as QQ group file media", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/files") {
        return Response.json({ file_info: "group-file-info" });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/messages") {
        return Response.json({ id: "group-file-message" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:group/group-openid", {
      files: [
        {
          data: new TextEncoder().encode("report").buffer,
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
      ],
      raw: "monthly report",
    });

    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/files")[0]!), {
      file_data: Buffer.from("report").toString("base64"),
      file_name: "report.pdf",
      file_type: 4,
      srv_send_msg: false,
    });
    assert.deepStrictEqual(fetchCalls(fetchMock, "/messages").map(requestJsonBody), [
      {
        content: "monthly report",
        msg_type: 0,
      },
      {
        media: { file_info: "group-file-info" },
        msg_type: 7,
      },
    ]);
  });

  it("reuses cached QQ media payloads until ttl expires", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    let uploadCount = 0;
    let messageCount = 0;
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        uploadCount += 1;
        return Response.json({
          file_info: "media-file-info",
          file_uuid: "media-file-uuid",
          ttl: 3600,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        messageCount += 1;
        return Response.json({
          id: `sent-message-${messageCount}`,
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const message = {
      attachments: [
        {
          type: "image" as const,
          url: "https://example.test/image.png",
        },
      ],
      raw: "image caption",
    };
    await adapter.postMessage("qq:c2c/user-openid", message);
    await adapter.postMessage("qq:c2c/user-openid", message);

    assert.strictEqual(uploadCount, 1);
    assert.strictEqual(messageCount, 4);
    assert.deepStrictEqual(fetchCalls(fetchMock, "/messages").map(requestJsonBody), [
      {
        content: "image caption",
        msg_type: 0,
      },
      {
        media: {
          file_info: "media-file-info",
          file_uuid: "media-file-uuid",
          ttl: 3600,
        },
        msg_type: 7,
      },
      {
        content: "image caption",
        msg_type: 0,
      },
      {
        media: {
          file_info: "media-file-info",
          file_uuid: "media-file-uuid",
          ttl: 3600,
        },
        msg_type: 7,
      },
    ]);
  });

  it("splits multiple image attachments into sequential QQ media messages", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    let uploadCount = 0;
    let messageCount = 0;
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        uploadCount += 1;
        return Response.json({
          file_info: `media-file-info-${uploadCount}`,
          file_uuid: `media-file-uuid-${uploadCount}`,
          ttl: 3600,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        messageCount += 1;
        return Response.json({
          id: `sent-message-${messageCount}`,
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const sent = await adapter.postMessage("qq:c2c/user-openid", {
      attachments: [
        {
          type: "image",
          url: "https://example.test/one.png",
        },
        {
          type: "image",
          url: "https://example.test/two.png",
        },
      ],
      raw: "image caption",
    });

    assert.strictEqual(sent.id, "sent-message-3");
    assert.deepStrictEqual(fetchCalls(fetchMock, "/messages").map(requestJsonBody), [
      {
        content: "image caption",
        msg_type: 0,
      },
      {
        media: {
          file_info: "media-file-info-1",
          file_uuid: "media-file-uuid-1",
          ttl: 3600,
        },
        msg_type: 7,
      },
      {
        media: {
          file_info: "media-file-info-2",
          file_uuid: "media-file-uuid-2",
          ttl: 3600,
        },
        msg_type: 7,
      },
    ]);
  });

  it("sends QQ Ark messages through adapter-specific API", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postArk("qq:c2c/user-openid", {
      kv: [
        {
          key: "#DESC#",
          value: "机器人订阅消息",
        },
      ],
      template_id: 23,
    });

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      ark: {
        kv: [
          {
            key: "#DESC#",
            value: "机器人订阅消息",
          },
        ],
        template_id: 23,
      },
      msg_type: 3,
    });
  });

  it("maps Chat SDK card buttons to QQ markdown keyboard", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage(
      "qq:c2c/user-openid",
      Card({
        children: [
          CardText("Choose an action"),
          Actions([
            Button({
              id: "approve",
              label: "Approve",
              style: "primary",
              value: "order-123",
            }),
            LinkButton({
              id: "docs",
              label: "Docs",
              url: "https://example.com/docs",
            }),
          ]),
        ],
        title: "Order #123",
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? ""));
    assertMatchObject(body, {
      keyboard: {
        content: {
          rows: [
            {
              buttons: [
                {
                  id: "approve",
                  action: {
                    data: "order-123",
                    permission: {
                      type: 2,
                    },
                    type: 1,
                    unsupport_tips: "Approve",
                  },
                  render_data: {
                    label: "Approve",
                    style: 3,
                    visited_label: "Approve",
                  },
                },
                {
                  id: "docs",
                  action: {
                    data: "https://example.com/docs",
                    permission: {
                      type: 2,
                    },
                    type: 0,
                    unsupport_tips: "Docs",
                  },
                  render_data: {
                    label: "Docs",
                    style: 0,
                    visited_label: "Docs",
                  },
                },
              ],
            },
          ],
        },
      },
      msg_type: 2,
    });
    assert.ok(
      (body.markdown as { content: string }).content.includes("Order #123"),
      'markdown.content includes "Order #123"',
    );
    assert.ok(
      (body.markdown as { content: string }).content.includes("Choose an action"),
      'markdown.content includes "Choose an action"',
    );
  });

  it("renders Chat SDK 4.34 table captions and charts as QQ markdown fallbacks", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({ id: "sent-message-1" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", Card({
      children: [
        Table({
          caption: "Monthly totals",
          headers: ["Month", "Value"],
          rows: [["May", "42"]],
        }),
        Chart({
          title: "Distribution",
          chart: {
            segments: [
              { label: "QQ", value: 70 },
              { label: "Other", value: 30 },
            ],
            type: "pie",
          },
        }),
      ],
    }));

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? ""));
    const markdown = body.markdown.content as string;
    assert.match(markdown, /Monthly totals/);
    assert.match(markdown, /\| Month \| Value \|/);
    assert.match(markdown, /Distribution/);
    assert.match(markdown, /QQ\s+\| 70/);
  });

  it("maps Chat SDK JSX URL card images and content to QQ markdown", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage(
      "qq:c2c/user-openid",
      Card({
        children: [
          CardText("hello"),
          Image({
            alt: "sample image",
            url: "https://example.test/image.png",
          }),
          Section([
            Fields([
              Field({ label: "Status", value: "OK" }),
            ]),
            CardLink({
              label: "Docs",
              url: "https://example.test/docs",
            }),
          ]),
          Divider(),
          Table({
            headers: ["Name", "Value"],
            rows: [["adapter", "qq"]],
          }),
        ],
        imageUrl: "https://example.test/header.png",
        subtitle: "subtitle",
        title: "title",
      }),
    );

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      markdown: {
        content: [
          "# title",
          "subtitle",
          "![img #618px #249px](https://example.test/header.png)",
          "hello",
          "![sample image #208px #320px](https://example.test/image.png)",
          "**Status**: OK\n[Docs](https://example.test/docs)",
          "---",
          "| Name | Value |\n| --- | --- |\n| adapter | qq |",
        ].join("\n\n"),
      },
      msg_type: 2,
    });
  });

  it("keeps data URL JSX card images on QQ media flow", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        return Response.json({
          file_info: "media-file-info",
          ttl: 3600,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage(
      "qq:c2c/user-openid",
      Card({
        children: [
          CardText("hello"),
          Image({
            alt: "sample image",
            url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
          }),
        ],
        title: "title",
      }),
    );

    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/files")[0]!), {
      file_data: Buffer.from("image-bytes").toString("base64"),
      file_type: 1,
      srv_send_msg: false,
    });
    const messageBodies = fetchCalls(fetchMock, "/messages").map(requestJsonBody);
    assert.strictEqual(messageBodies[0]?.msg_type, 2);
    assert.ok(String(messageBodies[0]?.markdown && (messageBodies[0].markdown as { content: string }).content).includes("title"));
    assert.deepStrictEqual(messageBodies[1], {
      media: {
        file_info: "media-file-info",
        ttl: 3600,
      },
      msg_type: 7,
    });
  });

  it("sends media-only messages as clean msg_type=7 payloads", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url.endsWith("/files")) {
        return Response.json({ file_info: "media-file-info" });
      }
      if (url.endsWith("/messages")) {
        return Response.json({ id: "sent-message-1" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      attachments: [{ type: "image", url: "https://example.test/image.png" }],
      raw: "",
    });

    assert.deepStrictEqual(fetchCalls(fetchMock, "/messages").map(requestJsonBody), [
      {
        media: { file_info: "media-file-info" },
        msg_type: 7,
      },
    ]);
  });

  it("uses chunked upload for local files above the configured threshold", async () => {
    const adapter = createAdapter({
      chunkedUploadThresholdBytes: 4,
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const data = Buffer.from("0123456789");
    const fetchMock = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/upload_prepare") {
        return Response.json({
          block_size: "10",
          parts: [
            {
              block_size: "10",
              index: 0,
              presigned_url: "https://cos.example.test/part0",
            },
          ],
          upload_config: { concurrency: 1 },
          upload_id: "upload-1",
        });
      }
      if (url === "https://cos.example.test/part0") {
        assert.strictEqual(init?.method, "PUT");
        assert.ok(!(init?.headers as Record<string, string> | undefined)?.Authorization);
        return new Response(null, { status: 200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/upload_part_finish") {
        return Response.json({});
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/files") {
        return Response.json({ file_info: "chunked-file-info", ttl: 300 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({ id: "sent-message-1" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", {
      attachments: [
        {
          data,
          name: "clip.bin",
          type: "file",
        },
      ],
      raw: "",
    });

    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/upload_prepare")[0]!), {
      file_name: "clip.bin",
      file_size: "10",
      file_type: 4,
      md5: createHash("md5").update(data).digest("hex"),
      md5_10m: createHash("md5").update(data).digest("hex"),
      sha1: createHash("sha1").update(data).digest("hex"),
    });
    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/upload_part_finish")[0]!), {
      block_size: "10",
      md5: createHash("md5").update(data).digest("hex"),
      part_index: 0,
      upload_id: "upload-1",
    });
    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/files")[0]!), {
      file_name: "clip.bin",
      file_type: 4,
      srv_send_msg: false,
      upload_id: "upload-1",
    });
    assert.deepStrictEqual(fetchCalls(fetchMock, "/messages").map(requestJsonBody), [
      {
        media: { file_info: "chunked-file-info", ttl: 300 },
        msg_type: 7,
      },
    ]);
  });

  it("uses group chunked-upload endpoints for large group files", async () => {
    const adapter = createAdapter({
      chunkedUploadThresholdBytes: 4,
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const data = Buffer.from("group-file");
    const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/upload_prepare") {
        return Response.json({
          block_size: String(data.byteLength),
          parts: [{ index: 0, presigned_url: "https://cos.example.test/group-part", block_size: String(data.byteLength) }],
          upload_id: "group-upload",
        });
      }
      if (url === "https://cos.example.test/group-part") {
        return new Response(null, { status: 200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/upload_part_finish") {
        return Response.json({});
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/files") {
        return Response.json({ file_info: "group-chunked-info" });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/messages") {
        return Response.json({ id: "group-sent" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:group/group-openid", {
      files: [{ data, filename: "notes.txt", mimeType: "text/plain" }],
      raw: "",
    });

    assert.ok(fetchCalls(fetchMock, "/v2/groups/group-openid/upload_prepare").length === 1);
    assert.deepStrictEqual(requestJsonBody(fetchCalls(fetchMock, "/files")[0]!), {
      file_name: "notes.txt",
      file_type: 4,
      srv_send_msg: false,
      upload_id: "group-upload",
    });
  });

  it("falls back to the wiki api.bot.qq.com host when the default token host is unreachable", async () => {
    const adapter = createAdapter();
    const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === DEFAULT_TOKEN_ENDPOINT) {
        throw new TypeError("fetch failed");
      }
      if (url === BOT_TOKEN_ENDPOINT) {
        return Response.json({ access_token: "fallback-token", expires_in: 7200 });
      }
      if (url === `${BOT_API_BASE_URL}/v2/users/user-openid/messages`) {
        return Response.json({ id: "sent-message-1" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", "hello");

    assert.deepStrictEqual(
      fetchMock.mock.calls.map((call) => String(call.arguments[0])),
      [DEFAULT_TOKEN_ENDPOINT, BOT_TOKEN_ENDPOINT, `${BOT_API_BASE_URL}/v2/users/user-openid/messages`],
    );
  });

  it("rejects Chat SDK modal buttons as NotImplemented", async () => {
    const adapter = createAdapter();
    await assert.rejects(
      adapter.postMessage(
        "qq:c2c/user-openid",
        Card({
          children: [
            Actions([
              Button({
                actionType: "modal",
                id: "open-modal",
                label: "Open",
              }),
            ]),
          ],
        }),
      ),
      /QQ keyboard does not support modal buttons/,
    );
  });

  it("streams C2C messages using QQ native stream_messages API", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/stream_messages") {
        return Response.json({
          id: "stream-msg-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await initializeWithProcessSpy(adapter);
    await adapter.handleSocketModePayload({
      d: {
        author: { user_openid: "user-openid" },
        content: "start stream",
        id: "message-stream",
        timestamp: "2026-05-09T12:00:00+08:00",
      },
      id: "event-stream",
      op: 0,
      s: 1,
      t: "C2C_MESSAGE_CREATE",
    });

    async function* chunks() {
      yield "hello ";
      // Allow the scheduled intermediate update to fire.
      await new Promise((r) => setTimeout(r, 600));
      yield {
        text: "**world**",
        type: "markdown_text" as const,
      };
    }

    await adapter.stream("qq:c2c/user-openid", chunks());

    // Token + intermediate + final stream_messages calls.
    assert.ok(fetchMock.mock.callCount() >= 3);

    const streamCalls = fetchMock.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("/stream_messages")
    );
    assert.ok(streamCalls.length >= 2);

    // First intermediate call.
    const firstBody = JSON.parse(String(streamCalls[0]?.arguments[1]?.body ?? ""));
    assert.strictEqual(firstBody.input_mode, "replace");
    assert.strictEqual(firstBody.input_state, 1);
    assert.strictEqual(firstBody.content_type, "markdown");
    assert.strictEqual(firstBody.index, 0);
    assert.strictEqual(firstBody.stream_msg_id, undefined);
    assert.strictEqual(firstBody.event_id, "event-stream");
    assert.strictEqual(firstBody.msg_id, "message-stream");
    assert.strictEqual(firstBody.msg_seq, 2);

    // Final call.
    const lastBody = JSON.parse(String(streamCalls[streamCalls.length - 1]?.arguments[1]?.body ?? ""));
    assert.strictEqual(lastBody.input_mode, "replace");
    assert.strictEqual(lastBody.input_state, 10);
    assert.strictEqual(lastBody.content_type, "markdown");
    assert.strictEqual(lastBody.content_raw, "hello **world**");
    assert.strictEqual(lastBody.stream_msg_id, "stream-msg-1");
    assert.strictEqual(lastBody.msg_seq, 2);
  });

  it("falls back to regular message when stream_messages API fails in C2C", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      // stream_messages returns 404 to simulate API failure.
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await initializeWithProcessSpy(adapter);
    await adapter.handleSocketModePayload({
      d: {
        author: { user_openid: "user-openid" },
        content: "start stream",
        id: "message-stream",
        timestamp: "2026-05-09T12:00:00+08:00",
      },
      id: "event-stream",
      op: 0,
      s: 1,
      t: "C2C_MESSAGE_CREATE",
    });

    async function* chunks() {
      yield "hello ";
      await new Promise((r) => setTimeout(r, 600));
      yield {
        text: "**world**",
        type: "markdown_text" as const,
      };
    }

    await adapter.stream("qq:c2c/user-openid", chunks());

    // Token + startTyping + failed stream_messages + fallback message.
    assert.strictEqual(fetchMock.mock.callCount(), 4);
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      input_notify: {
        input_second: 60,
        input_type: 1,
      },
      msg_id: "message-stream",
      msg_seq: 1,
      msg_type: 6,
    });
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[3]?.arguments[1]?.body ?? "")), {
      content: "hello **world**",
      msg_id: "message-stream",
      msg_seq: 3,
      msg_type: 0,
    });
  });

  it("falls back to regular message for group streams", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/groups/group-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    async function* chunks() {
      yield "hello ";
      yield "group";
    }

    await adapter.stream("qq:group/group-openid", chunks());

    assert.strictEqual(fetchMock.mock.callCount(), 2);
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      content: "hello group",
      msg_type: 0,
    });
  });

  it("sends C2C typing indicator via input_notify", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({ id: "typing-ack", timestamp: "2026-05-09T12:00:01+08:00" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.startTyping("qq:c2c/user-openid");

    assert.strictEqual(fetchMock.mock.callCount(), 2);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? ""));
    assert.strictEqual(body.msg_type, 6);
    assert.deepStrictEqual(body.input_notify, {
      input_second: 60,
      input_type: 1,
    });
  });

  it("sends C2C typing indicator with passive context msg_id and msg_seq", async () => {
    const adapter = createAdapter({
      requireAppIdHeader: false,
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({ id: "typing-ack", timestamp: "2026-05-09T12:00:01+08:00" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await initializeWithProcessSpy(adapter);

    // Simulate a previous message establishing passive context.
    await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: { user_openid: "user-openid" },
            content: "hello",
            id: "msg-1",
            msg_id: "msg-id-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-envelope-id",
          op: 0,
          s: 10,
          t: "C2C_MESSAGE_CREATE",
        }),
        method: "POST",
      }),
    );

    await adapter.startTyping("qq:c2c/user-openid");

    const typingBody = JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? ""));
    assert.strictEqual(typingBody.msg_type, 6);
    assert.strictEqual(typingBody.msg_id, "msg-id-1");
    assert.strictEqual(typingBody.msg_seq, 1);

    // Next message should use msg_seq=2 after startTyping consumed msg_seq=1.
    await adapter.postMessage("qq:c2c/user-openid", "hello");
    const messageBody = JSON.parse(String(fetchMock.mock.calls[2]?.arguments[1]?.body ?? ""));
    assert.strictEqual(messageBody.msg_seq, 2);
  });

  it("does nothing for group typing indicator", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.startTyping("qq:group/group-openid");

    // Group typing is a no-op; no API call is made.
    assert.strictEqual(fetchMock.mock.callCount(), 0);
  });
});

describe("QQAdapter outbound passive context", () => {
  it("uses msg_id and msg_seq for passive message replies without leaking envelope event_id", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    await initializeWithProcessSpy(adapter);

    await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: {
            author: {
              user_openid: "user-openid",
            },
            content: "hello",
            id: "message-1",
            timestamp: "2026-05-09T12:00:00+08:00",
          },
          id: "event-envelope-id",
          op: 0,
          s: 10,
          t: "C2C_MESSAGE_CREATE",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    const fetchMock = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          id: "sent-message-1",
          timestamp: "2026-05-09T12:00:01+08:00",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postMessage("qq:c2c/user-openid", "reply 1");
    await adapter.postMessage("qq:c2c/user-openid", "reply 2");

    const firstSendBody = JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? ""));
    const secondSendBody = JSON.parse(String(fetchMock.mock.calls[2]?.arguments[1]?.body ?? ""));

    assert.deepStrictEqual(firstSendBody, {
      content: "reply 1",
      msg_id: "message-1",
      msg_seq: 1,
      msg_type: 0,
    });
    assert.deepStrictEqual(secondSendBody, {
      content: "reply 2",
      msg_id: "message-1",
      msg_seq: 2,
      msg_type: 0,
    });
  });
});

describe("QQAdapter latest QQ and Chat SDK protocol behavior", () => {
  it("enables Chat SDK state-backed thread history", () => {
    assert.strictEqual(createAdapter().persistThreadHistory, true);
  });

  it("returns accepted raw messages for QQ 202 asynchronous sends", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({
          audit_id: "audit-1",
          code: 304023,
          message: "accepted for asynchronous audit",
        }, { status: 202 });
      }
      return Response.json({ code: 404 }, { status: 404 });
    }) as typeof globalThis.fetch;

    const sent = await adapter.postMessage("qq:c2c/user-openid", "proactive");

    assert.strictEqual(sent.id, "qq:pending/audit-1");
    assertMatchObject(sent.raw, {
      _chat_async_code: 304023,
      _chat_async_message: "accepted for asynchronous audit",
      _chat_delivery_status: "accepted",
      _chat_http_status: 202,
    });
  });

  it("maps QQ business-code rate limits and Retry-After", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      return Response.json({ code: 304045, message: "rate limited" }, {
        headers: { "Retry-After": "2" },
        status: 200,
      });
    }) as typeof globalThis.fetch;

    await assert.rejects(
      adapter.postMessage("qq:c2c/user-openid", "hello"),
      (error: unknown) => {
        assertMatchObject(error, { code: "RATE_LIMITED", retryAfterMs: 2000 });
        return true;
      },
    );
  });

  it("supports QQ-specific wake-up and message-reference send options", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    await initializeWithProcessSpy(adapter);
    await adapter.handleSocketModePayload({
      d: {
        author: { user_openid: "user-openid" },
        content: "hello",
        id: "incoming-message",
      },
      id: "incoming-event",
      op: 0,
      t: "C2C_MESSAGE_CREATE",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/v2/users/user-openid/messages") {
        return Response.json({ id: "sent-wakeup" });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await adapter.postQQMessage("qq:c2c/user-openid", "wake up", {
      isWakeup: true,
      messageReference: {
        ignore_get_message_error: true,
        message_id: "referenced-message",
      },
    });

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      content: "wake up",
      is_wakeup: true,
      message_reference: {
        ignore_get_message_error: true,
        message_id: "referenced-message",
      },
      msg_type: 0,
    });
    await assert.rejects(
      adapter.postQQMessage("qq:c2c/user-openid", "invalid", {
        isWakeup: true,
        passiveContext: true,
      }),
      /cannot be combined with passive reply context/,
    );
  });

  it("dispatches asynchronous message audit events", async () => {
    const adapter = createAdapter();
    const handler = mock.fn();
    adapter.onEvent("MESSAGE_AUDIT_PASS", handler);

    await adapter.handleSocketModePayload({
      d: {
        audit_id: "audit-1",
        message_id: "message-1",
        user_openid: "user-openid",
      },
      id: "audit-event",
      op: 0,
      t: "MESSAGE_AUDIT_PASS",
    });

    assert.strictEqual(handler.mock.callCount(), 1);
    assertMatchObject(handler.mock.calls[0]?.arguments[0], {
      eventId: "audit-event",
      threadId: "qq:c2c/user-openid",
      type: "MESSAGE_AUDIT_PASS",
    });
  });
});

describe("QQAdapter socket mode", () => {
  it("dispatches QQ socket mode message events through Chat SDK", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);

    await adapter.handleSocketModePayload({
      d: {
        author: {
          user_openid: "user-openid",
        },
        content: "hello from socket mode",
        id: "message-1",
        timestamp: "2026-05-10T12:00:00+08:00",
      },
      op: 0,
      s: 1,
      t: "C2C_MESSAGE_CREATE",
    });

    assert.strictEqual(processMessage.mock.callCount(), 1);
    assert.strictEqual(processMessage.mock.calls[0]?.arguments[1], "qq:c2c/user-openid");
    assertMatchObject(processMessage.mock.calls[0]?.arguments[2], {
      id: "message-1",
      text: "hello from socket mode",
      threadId: "qq:c2c/user-openid",
    });
  });

  it("dedupes redelivered socket mode message events", async () => {
    const adapter = createAdapter();
    const processMessage = await initializeWithProcessSpy(adapter);
    const payload = {
      d: {
        author: { user_openid: "user-openid" },
        content: "hello from socket mode",
        id: "message-1",
        message_scene: { ext: ["msg_idx=IDX_1"] },
      },
      op: 0 as const,
      s: 1,
      t: "C2C_MESSAGE_CREATE" as const,
    };

    await adapter.handleSocketModePayload(payload);
    await adapter.handleSocketModePayload({ ...payload, s: 2 });

    assert.strictEqual(processMessage.mock.callCount(), 1);
  });

  it("connects in socket mode and identifies after hello", async () => {
    const sockets: MockSocketModeSocket[] = [];
    const adapter = createAdapter({
      mode: "socket",
      socketMode: {
        reconnect: false,
        webSocketFactory: (url: string) => {
          assert.strictEqual(url, "wss://gateway.example.test/websocket");
          const socket = new MockSocketModeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({
          access_token: "access-token",
          expires_in: 7200,
        });
      }
      if (url === "https://api.sgroup.qq.com/gateway/bot") {
        return Response.json({
          session_start_limit: {
            max_concurrency: 1,
            remaining: 1000,
            reset_after: 86400000,
            total: 1000,
          },
          shards: 1,
          url: "wss://gateway.example.test/websocket",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const start = adapter.startSocketMode();
    await nextTick();
    assert.strictEqual(sockets.length, 1);
    sockets[0]!.emit("open", new Event("open"));
    await start;

    sockets[0]!.emit("message", { data: JSON.stringify({ d: { heartbeat_interval: 1000 }, op: 10 }) } as MessageEvent);
    await nextTick();

    assert.deepStrictEqual(sockets[0]!.sent.map((payload) => JSON.parse(payload)), [
      {
        d: {
          intents: DEFAULT_GATEWAY_INTENTS,
          properties: {
            "$browser": "@amatsuka/chat-adapter-qq",
            "$device": "@amatsuka/chat-adapter-qq",
            "$os": "web",
          },
          shard: [0, 1],
          token: "QQBot access-token",
        },
        op: 2,
      },
      {
        d: null,
        op: 1,
      },
    ]);

    await adapter.stopSocketMode();
  });

  it("automatically starts every recommended gateway shard", async () => {
    const sockets: MockSocketModeSocket[] = [];
    const adapter = createAdapter({
      mode: "socket",
      socketMode: {
        reconnect: false,
        webSocketFactory: () => {
          const socket = new MockSocketModeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      if (url === "https://api.sgroup.qq.com/gateway/bot") {
        return Response.json({
          session_start_limit: { max_concurrency: 2, remaining: 10, reset_after: 60_000, total: 10 },
          shards: 2,
          url: "wss://gateway.example.test/websocket",
        });
      }
      return Response.json({ code: 404 }, { status: 404 });
    }) as typeof globalThis.fetch;

    const start = adapter.startSocketMode();
    await nextTick();
    assert.strictEqual(sockets.length, 2);
    sockets.forEach((socket) => socket.emit("open", new Event("open")));
    await start;
    sockets.forEach((socket) => socket.emit("message", {
      data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
    } as MessageEvent));
    await nextTick();

    const identifyShards = sockets.map((socket) => {
      const identify = socket.sent.map((payload) => JSON.parse(payload)).find((payload) => payload.op === 2);
      return identify.d.shard;
    });
    assert.deepStrictEqual(identifyShards, [[0, 2], [1, 2]]);
    await adapter.stopSocketMode();
  });

  it("rejects auto-sharding when the gateway start quota is insufficient", async () => {
    const adapter = createAdapter({
      mode: "socket",
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://tokens.example.test/app/getAppAccessToken") {
        return Response.json({ access_token: "access-token", expires_in: 7200 });
      }
      return Response.json({
        session_start_limit: { max_concurrency: 1, remaining: 1, reset_after: 12_345, total: 10 },
        shards: 2,
        url: "wss://gateway.example.test/websocket",
      });
    }) as typeof globalThis.fetch;

    await assert.rejects(adapter.startSocketMode(), (error: unknown) => {
      assertMatchObject(error, { code: "RATE_LIMITED", retryAfterMs: 12_345 });
      return true;
    });
  });

  it("resumes the previous gateway session after close code 4009", async () => {
    const sockets: MockSocketModeSocket[] = [];
    const adapter = createAdapter({
      mode: "socket",
      socketMode: {
        autoSharding: false,
        reconnectDelayMs: 0,
        url: "wss://gateway.example.test/websocket",
        webSocketFactory: () => {
          const socket = new MockSocketModeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async () => Response.json({
      access_token: "access-token",
      expires_in: 7200,
    })) as typeof globalThis.fetch;

    const start = adapter.startSocketMode();
    await nextTick();
    sockets[0]!.emit("open", new Event("open"));
    await start;
    sockets[0]!.emit("message", {
      data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
    } as MessageEvent);
    await nextTick();
    sockets[0]!.emit("message", {
      data: JSON.stringify({ d: { session_id: "session-resume" }, op: 0, s: 42, t: "READY" }),
    } as MessageEvent);
    await nextTick();

    sockets[0]!.emitClose(4009, "session reconnect");
    await nextTick();
    sockets[1]!.emit("open", new Event("open"));
    sockets[1]!.emit("message", {
      data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
    } as MessageEvent);
    await nextTick();

    assertMatchObject(JSON.parse(sockets[1]!.sent[0]!), {
      d: {
        seq: 42,
        session_id: "session-resume",
        token: "QQBot access-token",
      },
      op: 6,
    });
    await adapter.stopSocketMode();
  });

  it("re-identifies after invalid-session close codes and stops on terminal close codes", async () => {
    const sockets: MockSocketModeSocket[] = [];
    const adapter = createAdapter({
      mode: "socket",
      socketMode: {
        autoSharding: false,
        reconnectDelayMs: 0,
        url: "wss://gateway.example.test/websocket",
        webSocketFactory: () => {
          const socket = new MockSocketModeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    globalThis.fetch = mock.fn(async () => Response.json({
      access_token: "access-token",
      expires_in: 7200,
    })) as typeof globalThis.fetch;

    const start = adapter.startSocketMode();
    await nextTick();
    sockets[0]!.emit("open", new Event("open"));
    await start;
    sockets[0]!.emit("message", {
      data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
    } as MessageEvent);
    await nextTick();
    sockets[0]!.emit("message", {
      data: JSON.stringify({ d: { session_id: "session-1" }, op: 0, s: 7, t: "READY" }),
    } as MessageEvent);
    await nextTick();

    sockets[0]!.emitClose(4006, "invalid session");
    await nextTick();
    assert.strictEqual(sockets.length, 2);
    sockets[1]!.emit("open", new Event("open"));
    sockets[1]!.emit("message", {
      data: JSON.stringify({ d: { heartbeat_interval: 60_000 }, op: 10 }),
    } as MessageEvent);
    await nextTick();
    assert.strictEqual(JSON.parse(sockets[1]!.sent[0]!).op, 2);

    sockets[1]!.emitClose(4915, "bot unavailable");
    await nextTick();
    assert.strictEqual(sockets.length, 2);
    await adapter.stopSocketMode();
  });
});
