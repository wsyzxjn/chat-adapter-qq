import type { ChatInstance, Logger } from "chat";
import { Actions, Button, Card, CardLink, CardText, Divider, Field, Fields, Image, LinkButton, Section, Table } from "chat";
import { QQAdapter } from "@amatsuka/chat-adapter-qq";
import type { QQSocketModeAdapterConfig, QQWebhookAdapterConfig } from "@amatsuka/chat-adapter-qq";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

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

  close(): void {
    this.emit("close", new Event("close"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: "close" | "error" | "message" | "open", event: SocketModeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
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
      text: "hello group",
      threadId: "qq:group/group-openid",
    });
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
      text: "extra args",
      triggerId: "message-1",
      user: {
        userId: "user-openid",
      },
    });
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

    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      file_type: 1,
      srv_send_msg: false,
      url: "https://example.test/image.png",
    });
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[2]?.arguments[1]?.body ?? "")), {
      content: "image caption",
      media: {
        file_info: "media-file-info",
        file_uuid: "media-file-uuid",
        ttl: 3600,
      },
      msg_type: 7,
    });
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
    assert.strictEqual(messageCount, 2);
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[3]?.arguments[1]?.body ?? "")), {
      content: "image caption",
      media: {
        file_info: "media-file-info",
        file_uuid: "media-file-uuid",
        ttl: 3600,
      },
      msg_type: 7,
    });
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

    assert.strictEqual(sent.id, "sent-message-2");
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[3]?.arguments[1]?.body ?? "")), {
      content: "image caption",
      media: {
        file_info: "media-file-info-1",
        file_uuid: "media-file-uuid-1",
        ttl: 3600,
      },
      msg_type: 7,
    });
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[4]?.arguments[1]?.body ?? "")), {
      content: " ",
      media: {
        file_info: "media-file-info-2",
        file_uuid: "media-file-uuid-2",
        ttl: 3600,
      },
      msg_type: 7,
    });
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
                    style: 1,
                    visited_label: "Approve",
                  },
                },
                {
                  action: {
                    data: "https://example.com/docs",
                    permission: {
                      type: 2,
                    },
                    type: 0,
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

  it("maps Chat SDK JSX card images and content to QQ media and markdown", async () => {
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
      file_type: 1,
      srv_send_msg: false,
      url: "https://example.test/header.png",
    });
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[3]?.arguments[1]?.body ?? "")), {
      content: [
        "# title",
        "subtitle",
        "hello",
        "**Status**: OK\n[Docs](https://example.test/docs)",
        "---",
        "| Name | Value |\n| --- | --- |\n| adapter | qq |",
      ].join("\n\n"),
      media: {
        file_info: "media-file-info-1",
        ttl: 3600,
      },
      msg_type: 7,
    });
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[4]?.arguments[1]?.body ?? "")), {
      content: " ",
      media: {
        file_info: "media-file-info-2",
        ttl: 3600,
      },
      msg_type: 7,
    });
  });

  it("streams by collecting chunks and posting once because QQ does not support editMessage", async () => {
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

    async function* chunks() {
      yield "hello ";
      yield {
        text: "**world**",
        type: "markdown_text" as const,
      };
    }

    await adapter.stream("qq:c2c/user-openid", chunks());

    assert.strictEqual(fetchMock.mock.callCount(), 2);
    assert.deepStrictEqual(JSON.parse(String(fetchMock.mock.calls[1]?.arguments[1]?.body ?? "")), {
      content: "hello **world**",
      msg_type: 0,
    });
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
        d: null,
        op: 1,
      },
      {
        d: {
          intents: (1 << 25) | (1 << 26),
          properties: {
            "$browser": "@amatsuka/chat-adapter-qq",
            "$device": "@amatsuka/chat-adapter-qq",
            "$os": process.platform,
          },
          shard: [0, 1],
          token: "QQBot access-token",
        },
        op: 2,
      },
    ]);

    await adapter.stopSocketMode();
  });
});
