import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { ChatInstance, Logger } from "chat";
import { Card, Image, TextInput } from "chat";
import { QQAdapter, QQ_INTENTS } from "@amatsuka/chat-adapter-qq";

const fetchOriginal = globalThis.fetch;
const logger: Logger = {
  child: () => logger,
  debug() {}, error() {}, info() {}, warn() {},
};

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  mock.restoreAll();
});

function createAdapter(): QQAdapter {
  return new QQAdapter({ appId: "test-app", clientSecret: "test-secret", logger, verifySignature: false });
}

function incoming(id: string) {
  return {
    op: 0, t: "C2C_MESSAGE_CREATE", id: `event-${id}`,
    d: { id, author: { user_openid: "user" }, content: "hello" },
  };
}

describe("QQ October 2026 protocol alignment", () => {
  it("uses the unified domain for tokens and OpenAPI calls", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json(calls.length === 1
        ? { access_token: "test-token", expires_in: 7200 }
        : { id: "sent" });
    }) as typeof fetch;

    await createAdapter().postMessage("qq:c2c/user", "hello");
    assert.deepStrictEqual(calls, [
      "https://api.bot.qq.com/app/getAppAccessToken",
      "https://api.bot.qq.com/v2/users/user/messages",
    ]);
  });

  it("rejects HTTP 200 err_code responses and preserves their trace IDs", async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => Response.json(
      String(input).endsWith("/getAppAccessToken")
        ? { access_token: "test-token", expires_in: 7200 }
        : { err_code: 40034100, message: "arbitrary text", trace_id: "trace-123" },
      { headers: { "Retry-After": "2" } },
    )) as typeof fetch;
    await assert.rejects(createAdapter().postMessage("qq:c2c/user", "hello"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code=40034100.*trace_id=trace-123/);
      assert.strictEqual((error as Error & { code: string }).code, "RATE_LIMITED");
      assert.strictEqual((error as Error & { retryAfterMs: number }).retryAfterMs, 2000);
      return true;
    });
  });

  it("classifies token business errors", async () => {
    for (const [body, code] of [
      [{ code: 100001, message: "arbitrary text" }, "RATE_LIMITED"],
      [{ code: 100016, message: "arbitrary text" }, "AUTH_FAILED"],
    ] as const) {
      const request = mock.fn(async () => Response.json(body));
      globalThis.fetch = request as typeof fetch;
      await assert.rejects(createAdapter().postMessage("qq:c2c/user", "hello"), { code });
      assert.strictEqual(request.mock.callCount(), 1);
    }
  });

  it("classifies QQ business codes and HTTP fallbacks without using message text", async () => {
    const cases = [
      { expected: "PERMISSION_DENIED", errCode: 11253 },
      { expected: "PERMISSION_DENIED", errCode: 11282 },
      { expected: "PERMISSION_DENIED", errCode: 304014 },
      { expected: "PERMISSION_DENIED", errCode: 306004 },
      { expected: "PERMISSION_DENIED", errCode: 40054013 },
      { expected: "PERMISSION_DENIED", errCode: 850018 },
      { expected: "NOT_FOUND", errCode: 304027 },
      { expected: "NOT_FOUND", errCode: 40034005 },
      { expected: "INVALID_REQUEST", errCode: 40034006 },
      { expected: "INVALID_REQUEST", errCode: 40054007 },
      { expected: "INVALID_REQUEST", errCode: 40064004 },
      { expected: "INVALID_REQUEST", errCode: 50048 },
      { expected: "RATE_LIMITED", errCode: 40034128 },
      { expected: "RATE_LIMITED", errCode: 50002 },
      { expected: "NETWORK_ERROR", errCode: 50055002 },
      { expected: "INVALID_REQUEST", status: 400 },
      { expected: "PERMISSION_DENIED", status: 403 },
    ] as const;
    let currentCase: (typeof cases)[number] = cases[0];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      return Response.json(
        "errCode" in currentCase
          ? { err_code: String(currentCase.errCode), code: 0, message: "rate auth permission timeout" }
          : { message: "rate auth permission timeout" },
        { status: "status" in currentCase ? currentCase.status : 200 },
      );
    }) as typeof fetch;
    const adapter = createAdapter();
    for (const testCase of cases) {
      currentCase = testCase;
      await assert.rejects(adapter.postMessage("qq:c2c/user", "hello"), { code: testCase.expected });
    }
  });

  it("keeps HTTP 202 err_code responses as asynchronous acceptance", async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      return Response.json({ err_code: 304023, audit_id: "audit-1" }, { status: 202 });
    }) as typeof fetch;
    const result = await createAdapter().postMessage("qq:c2c/user", "hello");
    assert.strictEqual(result.raw._chat_delivery_status, "accepted");
    assert.strictEqual(result.raw._chat_async_code, 304023);
    assert.strictEqual(result.id, "qq:pending/audit-1");
  });

  it("renders qqbot-media images directly in Markdown and Cards with image verification", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getAppAccessToken")) {
        return Response.json({ access_token: "test-token", expires_in: 7200 });
      }
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    const adapter = createAdapter();
    const imageUrl = "qqbot-media://image/v1/test-token";
    await adapter.postQQMessage("qq:c2c/user", { markdown: `![image](${imageUrl})` }, {
      forceVerifyImageResource: true,
    });
    await adapter.postQQMessage("qq:group/group", Card({ children: [Image({ url: imageUrl })] }), {
      forceVerifyImageResource: false,
    });
    assert.strictEqual(requests.length, 2);
    for (const [index, request] of requests.entries()) {
      assert.ok(request.url.endsWith("/messages"));
      assert.strictEqual(request.body.msg_type, 2);
      const markdown = request.body.markdown as { content: string; force_verify_image_resource: boolean };
      assert.match(markdown.content, /qqbot-media:\/\/image\/v1\/test-token/);
      assert.strictEqual(markdown.force_verify_image_resource, index === 0);
    }
  });

  it("rejects unsupported Card text inputs explicitly before making requests", async () => {
    const fetchSpy = mock.fn(async () => { throw new Error("Unexpected HTTP request"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    await assert.rejects(createAdapter().postMessage("qq:c2c/user", Card({
      children: [TextInput({ id: "name", label: "Name" })],
    })), { code: "NOT_IMPLEMENTED", feature: "text_input" });
    assert.strictEqual(fetchSpy.mock.callCount(), 0);
  });

  it("rejects image verification on media messages before uploading anything", async () => {
    const fetchSpy = mock.fn(async () => { throw new Error("Unexpected HTTP request"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    await assert.rejects(createAdapter().postQQMessage("qq:c2c/user", {
      markdown: "caption", attachments: [{ type: "image", data: Buffer.from("image") }],
    }, { forceVerifyImageResource: true }), { code: "INVALID_REQUEST" });
    assert.strictEqual(fetchSpy.mock.callCount(), 0);
  });

  it("routes feedback interactions to platform listeners without ACKing or dispatching buttons", async () => {
    const adapter = createAdapter();
    const action = mock.fn();
    const listener = mock.fn();
    await adapter.initialize({ processAction: action } as unknown as ChatInstance);
    adapter.onEvent("INTERACTION_CREATE", listener);
    const fetchSpy = mock.fn(async () => { throw new Error("Unexpected HTTP request"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    await adapter.handleSocketModePayload({
      op: 0, t: "INTERACTION_CREATE", id: "feedback-event",
      d: {
        id: "feedback-id", type: 13, scene: "c2c", user_openid: "user",
        data: { type: 13, resolved: { button_data: "feedback", feedback_opt: "LIKE", checked: 1 } },
      },
    });
    assert.strictEqual(action.mock.callCount(), 0);
    assert.strictEqual(fetchSpy.mock.callCount(), 0);
    assert.strictEqual(listener.mock.callCount(), 1);
    assert.strictEqual(listener.mock.calls[0]?.arguments[0].data.data.resolved.feedback_opt, "LIKE");
    assert.strictEqual(listener.mock.calls[0]?.arguments[0].threadId, "qq:c2c/user");
  });

  it("uses an interaction event as reply context even after a previous message", async () => {
    const adapter = createAdapter();
    const bodies: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getAppAccessToken")) return Response.json({ access_token: "test-token", expires_in: 7200 });
      bodies.push(JSON.parse(String(init?.body)));
      order.push(url.includes("/interactions/") ? "ack" : "post");
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    await adapter.initialize({ processMessage() {}, processAction() { order.push("action"); } } as unknown as ChatInstance);
    await adapter.handleSocketModePayload(incoming("old-message"));
    await adapter.handleSocketModePayload({
      op: 0, t: "INTERACTION_CREATE", id: "INTERACTION_CREATE:button-id",
      d: { id: "button-id", type: 12, scene: "c2c", user_openid: "user", data: { resolved: { feature_id: "help" } } },
    });
    await adapter.postMessage("qq:c2c/user", "help");
    assert.deepStrictEqual(order, ["ack", "action", "post"]);
    assert.deepStrictEqual(bodies.at(-1), { content: "help", msg_type: 0, event_id: "INTERACTION_CREATE:button-id" });
  });

  it("dispatches group member events without overwriting a message reply context", async () => {
    const adapter = createAdapter();
    const events = mock.fn();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/getAppAccessToken")) return Response.json({ access_token: "test-token", expires_in: 7200 });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    await adapter.initialize({ processMessage() {} } as unknown as ChatInstance);
    adapter.onEvent(["GROUP_MEMBER_ADD", "GROUP_MEMBER_REMOVE", "GROUP_JOIN_REQUEST"], events);
    await adapter.handleSocketModePayload({
      op: 0, t: "GROUP_MESSAGE_CREATE", d: { id: "group-message", group_openid: "group", content: "hello" },
    });
    for (const t of ["GROUP_MEMBER_ADD", "GROUP_MEMBER_REMOVE", "GROUP_JOIN_REQUEST"]) {
      await adapter.handleSocketModePayload({
        op: 0, t, id: `event-${t}`,
        d: { group_openid: "group", member_openid: "member", join_request_id: "request" },
      });
    }
    await adapter.postMessage("qq:group/group", "reply");
    assert.strictEqual(QQ_INTENTS.GROUP_MEMBER_EVENT, 1 << 24);
    assert.strictEqual(events.mock.callCount(), 3);
    assert.ok(events.mock.calls.every((call) => call.arguments[0].threadId === "qq:group/group"));
    assert.deepStrictEqual(bodies[0], { content: "reply", msg_type: 0, msg_id: "group-message", msg_seq: 1 });
  });
});
