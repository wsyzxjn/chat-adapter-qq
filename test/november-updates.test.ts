import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { ChatInstance, Logger, Message } from "chat";
import { QQAdapter } from "@amatsuka/chat-adapter-qq";
import type { QQIncomingMessage, QQMessageCard, QQPlatformEvent, QQUserInfo, QQWebhookPayload } from "@amatsuka/chat-adapter-qq";

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
  return new QQAdapter({
    appId: "test-app", apiHost: "bot", clientSecret: "test-secret",
    hostFallback: false, logger, verifySignature: false,
  });
}

const card: QQMessageCard = {
  type: "tuwen",
  content: {
    title: "今日推荐", description: "查看本期精选内容",
    url: "https://example.com/article", pic_url: "https://example.com/cover.png",
  },
};

describe("QQ October 26–November 16 updates", () => {
  it("queries user profiles with encoded openids and exposes Chat SDK UserInfo", async () => {
    const calls: string[] = [];
    const info: QQUserInfo = {
      username: "用户😊", avatar: "https://example.com/avatar.png",
      union_openid: "union-user", allow_proactive_msg: false,
    };
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/getAppAccessToken")) {
        return Response.json({ access_token: "token", expires_in: 7200 });
      }
      assert.strictEqual(init?.method, "GET");
      assert.strictEqual(new Headers(init?.headers).get("Authorization"), "QQBot token");
      calls.push(String(input));
      return Response.json(info);
    }) as typeof fetch;
    const adapter = createAdapter();
    assert.deepStrictEqual(await adapter.getQQUserInfo("user/id?"), info);
    assert.deepStrictEqual(await adapter.getUser("user/id?"), {
      avatarUrl: info.avatar, fullName: info.username, isBot: false,
      userId: "user/id?", userName: info.username,
    });
    assert.deepStrictEqual(calls, Array(2).fill("https://api.bot.qq.com/v2/users/user%2Fid%3F/info"));
  });

  it("maps missing friendship to PERMISSION_DENIED without matching error text", async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => Response.json(
      String(input).endsWith("/getAppAccessToken")
        ? { access_token: "token", expires_in: 7200 }
        : { code: 0, err_code: 40184001, message: "arbitrary text" },
    )) as typeof fetch;
    await assert.rejects(createAdapter().getQQUserInfo("user"), { code: "PERMISSION_DENIED" });
  });

  for (const transport of ["webhook", "socket"] as const) {
    it(`preserves group nicknames, avatars and union IDs through ${transport}`, async () => {
      const adapter = createAdapter();
      const messages: QQIncomingMessage[] = [];
      const events: QQPlatformEvent[] = [];
      await adapter.initialize({
        processMessage(_adapter: unknown, _thread: unknown, message: Message<QQIncomingMessage>) { messages.push(message.raw); },
      } as unknown as ChatInstance);
      adapter.onEvent((event) => { events.push(event); });
      const send = async (payload: QQWebhookPayload) => {
        if (transport === "socket") {
          await adapter.handleSocketModePayload(payload);
        } else {
          const response = await adapter.handleWebhook(new Request("https://example.com/qq", {
            method: "POST", headers: { "X-Bot-Appid": "test-app" }, body: JSON.stringify(payload),
          }));
          assert.strictEqual(response.status, 200);
        }
      };
      for (const type of ["GROUP_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"]) {
        await send({
          op: 0, t: type, id: `event-${type}`,
          d: {
            id: `message-${type}`, content: "hello",
            ...(type !== "C2C_MESSAGE_CREATE" ? { group_openid: "group", union_group_openid: "union-group" } : {}),
            author: {
              user_openid: "user", username: "账号昵称", avatar: "https://example.com/avatar.png",
              ...(type !== "C2C_MESSAGE_CREATE" ? { member_openid: "member", member_nickname: "群昵称" } : {}),
            },
          },
        });
      }
      assert.strictEqual(messages.length, 3);
      const group = adapter.parseMessage(messages[0]!);
      assert.strictEqual(group.author.fullName, "群昵称");
      assert.strictEqual(group.author.userName, "账号昵称");
      assert.strictEqual(group.author.userId, "member");
      assert.strictEqual(group.threadId, "qq:group/group");
      assert.strictEqual(group.raw.union_group_openid, "union-group");
      assert.strictEqual(group.raw.author?.avatar, "https://example.com/avatar.png");
      assert.strictEqual(adapter.parseMessage(messages[1]!).author.fullName, "群昵称");
      assert.strictEqual(adapter.parseMessage(messages[2]!).author.fullName, "账号昵称");
      const withoutNickname = { ...messages[0]!, author: { ...messages[0]!.author, member_nickname: "" } };
      assert.strictEqual(adapter.parseMessage(withoutNickname).author.fullName, "账号昵称");
      for (const type of ["GROUP_ADD_ROBOT", "GROUP_DEL_ROBOT", "GROUP_MEMBER_ADD", "GROUP_MEMBER_REMOVE"]) {
        await send({ op: 0, t: type, id: `event-${type}`, d: { group_openid: "group", union_group_openid: "union-group" } });
      }
      assert.strictEqual(events.length, 4);
      for (const event of events) {
        assert.strictEqual(event.threadId, "qq:group/group");
        assert.strictEqual((event.data as { union_group_openid?: string }).union_group_openid, "union-group");
      }
      await adapter.disconnect();
    });
  }

  it("retains union_group_openid from group info queries", async () => {
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => Response.json(
      String(input).endsWith("/getAppAccessToken")
        ? { access_token: "token", expires_in: 7200 }
        : { group_openid: "group", union_group_openid: "union-group", group_name: "群聊" },
    )) as typeof fetch;
    const info = await createAdapter().getQQGroupInfo("qq:group/group");
    assert.strictEqual(info.union_group_openid, "union-group");
  });

  it("sends native cards in C2C and groups with clean payloads and passive sequences", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/getAppAccessToken")) return Response.json({ access_token: "token", expires_in: 7200 });
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: `sent-${calls.length}` });
    }) as typeof fetch;
    const adapter = createAdapter();
    await adapter.initialize({ processMessage() {} } as unknown as ChatInstance);
    for (const type of ["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]) {
      await adapter.handleSocketModePayload({
        op: 0, t: type, id: `event-${type}`,
        d: { id: `in-${type}`, content: "hello", author: { user_openid: "user", member_openid: "member" },
          ...(type === "GROUP_AT_MESSAGE_CREATE" ? { group_openid: "group" } : {}) },
      });
      const threadId = type === "C2C_MESSAGE_CREATE" ? "qq:c2c/user" : "qq:group/group";
      const sent = await adapter.postQQCard(threadId, card);
      assert.deepStrictEqual(sent.raw.card, card);
      assert.match(adapter.parseMessage(sent.raw).text, /今日推荐/);
      await adapter.postMessage(threadId, "follow-up");
      assert.deepStrictEqual(calls.at(-2), {
        url: `https://api.bot.qq.com/v2/${type === "C2C_MESSAGE_CREATE" ? "users/user" : "groups/group"}/messages`,
        body: { card, msg_type: 8, msg_id: `in-${type}`, msg_seq: 1 },
      });
      assert.deepStrictEqual(calls.at(-1)?.body, { content: "follow-up", msg_type: 0, msg_id: `in-${type}`, msg_seq: 2 });
    }
    await adapter.postQQCard("qq:c2c/proactive-user", card);
    assert.deepStrictEqual(calls.at(-1)?.body, { card, msg_type: 8 });
    await adapter.disconnect();
  });

  it("validates native card limits and HTTPS URLs before requesting", async () => {
    const fetchSpy = mock.fn(async () => { throw new Error("Unexpected request"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    for (const content of [
      { title: "" }, { title: "字".repeat(51) }, { description: "" }, { description: "字".repeat(201) },
      { url: "http://example.com" }, { pic_url: "not-a-url" },
      { url: `https://example.com/${"a".repeat(1024)}` },
    ]) {
      await assert.rejects(createAdapter().postQQCard("qq:c2c/user", {
        ...card, content: { ...card.content, ...content },
      }), { code: "INVALID_REQUEST" });
    }
    assert.strictEqual(fetchSpy.mock.callCount(), 0);
  });

  it("preserves @everyone in text and Markdown, including image normalization", async () => {
    const bodies: Array<{ content?: string; markdown?: { content: string } }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/getAppAccessToken")) return Response.json({ access_token: "token", expires_in: 7200 });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    const adapter = createAdapter();
    const text = `${adapter.mentionEveryone()} 群公告`;
    await adapter.postMessage("qq:group/group", text);
    await adapter.postMessage("qq:group/group", { markdown: `${text}\n\n![cover](https://example.com/image.png)` });
    assert.strictEqual(bodies[0]?.content, text);
    assert.ok(bodies[1]?.markdown?.content.includes("<qqbot-at-everyone />"));
  });
});
