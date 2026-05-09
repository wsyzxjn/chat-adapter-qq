import type { ChatInstance, Logger } from "chat";
import { Actions, Button, Card, CardText, LinkButton } from "chat";
import { createPrivateKey, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QQAdapter } from "../src/adapter.js";

const APP_ID = "11111111";
const BOT_SECRET = "DG5g3B4j9X2KOErG";
const ED25519_PRIVATE_KEY_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

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

function createBotSeed(secret: string): Buffer {
  const source = Buffer.from(secret, "utf8");
  const seed = Buffer.alloc(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = source[index % source.length];
  }
  return seed;
}

function signQQMessage(secret: string, message: string): string {
  const privateKey = createPrivateKey({
    format: "der",
    key: Buffer.concat([ED25519_PRIVATE_KEY_DER_PREFIX, createBotSeed(secret)]),
    type: "pkcs8",
  });
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");
}

function signedRequest(body: string, options: { signature?: string; timestamp?: string } = {}): Request {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = options.signature ?? signQQMessage(BOT_SECRET, `${timestamp}${body}`);
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
  const processMessage = vi.fn();
  await adapter.initialize({ processMessage } as unknown as ChatInstance);
  return processMessage;
}

async function initializeWithProcessActionSpy(adapter: QQAdapter) {
  const processAction = vi.fn();
  await adapter.initialize({ processAction } as unknown as ChatInstance);
  return processAction;
}

async function initializeWithProcessSlashCommandSpy(adapter: QQAdapter) {
  const processMessage = vi.fn();
  const processSlashCommand = vi.fn();
  await adapter.initialize({ processMessage, processSlashCommand } as unknown as ChatInstance);
  return { processMessage, processSlashCommand };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

    await expect(response.json()).resolves.toEqual({
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

    const response = await adapter.handleWebhook(signedRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
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
      signedRequest(body, {
        signature: "00".repeat(64),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
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

    const response = await adapter.handleWebhook(signedRequest("{not-json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
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

    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage.mock.calls[0]?.[1]).toBe("qq:c2c/user-openid");
    expect(processMessage.mock.calls[0]?.[2]).toMatchObject({
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

    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      d: {
        seq: 8,
      },
      op: 12,
    });
  });

  it("dispatches known QQ platform events to adapter onEvent handlers", async () => {
    const onEvent = vi.fn();
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

    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      data: {
        openid: "user-openid",
      },
      eventId: "event-1",
      type: "FRIEND_ADD",
    });
  });

  it("supports catch-all QQ platform event handlers and unsubscribe", async () => {
    const onEvent = vi.fn();
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

    expect(onEvent).toHaveBeenCalledTimes(1);
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

    expect(response.status).toBe(400);
    expect(processMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
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

    expect(response.status).toBe(200);
    expect(processMessage).not.toHaveBeenCalled();
    expect(processSlashCommand).toHaveBeenCalledTimes(1);
    expect(processSlashCommand.mock.calls[0]?.[0]).toMatchObject({
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

    expect(response.status).toBe(200);
    expect(processAction).toHaveBeenCalledTimes(1);
    expect(processAction.mock.calls[0]?.[0]).toMatchObject({
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
    const processAction = vi.fn(() => {
      order.push("action");
    });
    await adapter.initialize({ processAction } as unknown as ChatInstance);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

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

    expect(response.status).toBe(200);
    expect(order).toEqual(["ack", "action"]);
  });
});

describe("QQAdapter outbound rich messages", () => {
  it("sends Chat SDK markdown as QQ native markdown", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

    await adapter.postMessage("qq:c2c/user-openid", {
      markdown: "**hello**",
    });

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

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

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
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
    expect(body.markdown.content).toContain("Order #123");
    expect(body.markdown.content).toContain("Choose an action");
  });

  it("streams by collecting chunks and posting once because QQ does not support editMessage", async () => {
    const adapter = createAdapter({
      tokenEndpoint: "https://tokens.example.test/app/getAppAccessToken",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

    async function* chunks() {
      yield "hello ";
      yield {
        text: "**world**",
        type: "markdown_text" as const,
      };
    }

    await adapter.stream("qq:c2c/user-openid", chunks());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
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

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    vi.stubGlobal("fetch", fetchMock);

    await adapter.postMessage("qq:c2c/user-openid", "reply 1");
    await adapter.postMessage("qq:c2c/user-openid", "reply 2");

    const firstSendBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const secondSendBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));

    expect(firstSendBody).toEqual({
      content: "reply 1",
      msg_id: "message-1",
      msg_seq: 1,
      msg_type: 0,
    });
    expect(secondSendBody).toEqual({
      content: "reply 2",
      msg_id: "message-1",
      msg_seq: 2,
      msg_type: 0,
    });
  });
});
