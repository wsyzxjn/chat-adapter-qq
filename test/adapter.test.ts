import type { ChatInstance, Logger } from "chat";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { QQAdapter } from "@amatsuka/chat-adapter-qq";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const APP_ID = "11111111";
const BOT_SECRET = "DG5g3B4j9X2KOErG";
const ED25519_PRIVATE_KEY_DER_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function createAdapter(config: Partial<ConstructorParameters<typeof QQAdapter>[0]> = {}): QQAdapter {
  return new QQAdapter({
    appId: APP_ID,
    clientSecret: BOT_SECRET,
    logger: createSilentLogger(),
    verifySignature: false,
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
    seed[index] = source[index % source.length];
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
});

describe("QQAdapter outbound rich messages", () => {
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
