import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";
import type { ChatInstance, Logger } from "chat";
import { QQAdapter } from "@amatsuka/chat-adapter-qq";

const fetchOriginal = globalThis.fetch;
const logger: Logger = {
  child: () => logger,
  debug() {},
  error() {},
  info() {},
  warn() {},
};

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  mock.restoreAll();
});

function createAdapter(): QQAdapter {
  return new QQAdapter({
    appId: "test-app",
    clientSecret: "test-secret",
    logger,
    verifySignature: false,
  });
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
}

function tokenResponse(url: string): Response | null {
  return url.endsWith("/getAppAccessToken")
    ? Response.json({ access_token: "test-token", expires_in: 7200 })
    : null;
}

function emptyResponse(): Response {
  return new Response(null, { status: 204 });
}

describe("QQ official C2C and group features", () => {
  it("uploads, lists, and deletes reusable Markdown images", async () => {
    const bytes = Buffer.from("png-image-data");
    const md5 = createHash("md5").update(bytes).digest("hex");
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    const calls: Array<{ body: Record<string, unknown>; method: string; url: string }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      const method = init?.method ?? "GET";
      if (url === "https://upload.example.test/image") {
        assert.strictEqual(method, "PUT");
        assert.strictEqual(new Headers(init?.headers).get("Content-Type"), "image/png");
        assert.deepStrictEqual(new Uint8Array(init?.body as ArrayBuffer), new Uint8Array(bytes));
        return new Response(null, { status: 200, headers: { ETag: `"${md5}"` } });
      }
      const body = bodyOf(init);
      calls.push({ body, method, url });
      if (url.endsWith("/media-images/prepare")) {
        return Response.json({
          expires_in: 3600,
          presigned_url: "https://upload.example.test/image",
          upload_id: "upload-image",
        });
      }
      if (url.endsWith("/media-images/complete")) {
        return Response.json({
          image_id: "image-1",
          preview_url: "https://preview.example.test/image",
          ttl: 7776000,
          url: "qqbot-media://image/v1/token",
        });
      }
      if (url.includes("/v2/media-images?cursor=cursor-2")) {
        return Response.json({
          images: [{
            created_at: 1,
            expires_at: 2,
            file_name: "chart.png",
            image_id: "image-1",
            url: "qqbot-media://image/v1/token",
          }],
          next_cursor: "",
          total: 1,
        });
      }
      if (url.endsWith("/media-images/image-1/delete")) {
        return emptyResponse();
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const adapter = createAdapter();
    const uploaded = await adapter.uploadQQMediaImage({
      data: bytes,
      fileName: "chart.png",
      mimeType: "image/png",
    });
    const listed = await adapter.listQQMediaImages({ cursor: "cursor-2" });
    await adapter.deleteQQMediaImage("image-1");

    assert.strictEqual(uploaded.image_id, "image-1");
    assert.strictEqual(listed.total, 1);
    assert.deepStrictEqual(calls[0], {
      body: {
        content_type: "image/png",
        file_name: "chart.png",
        file_size: bytes.byteLength,
        md5,
        sha1,
      },
      method: "POST",
      url: "https://api.bot.qq.com/v2/media-images/prepare",
    });
    assert.deepStrictEqual(calls[1], {
      body: { md5, upload_id: "upload-image" },
      method: "POST",
      url: "https://api.bot.qq.com/v2/media-images/complete",
    });
    assert.deepStrictEqual(calls[2], {
      body: {},
      method: "GET",
      url: "https://api.bot.qq.com/v2/media-images?cursor=cursor-2",
    });
    assert.deepStrictEqual(calls[3], {
      body: {},
      method: "DELETE",
      url: "https://api.bot.qq.com/v2/media-images/image-1/delete",
    });
  });

  it("automatically uses official multipart upload for binary files over 5 MiB", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
    const firstSize = 3 * 1024 * 1024;
    const calls: Array<{ body?: Record<string, unknown>; method: string; url: string }> = [];
    let firstPartAttempts = 0;
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      const method = init?.method ?? "GET";
      if (url.includes("upload.example.test/part/")) {
        const partIndex = Number(url.slice(url.lastIndexOf("/") + 1));
        const data = new Uint8Array(init?.body as ArrayBuffer);
        assert.strictEqual(data.byteLength, partIndex === 0 ? firstSize : bytes.byteLength - firstSize);
        if (partIndex === 0 && ++firstPartAttempts === 1) {
          return Response.json({ message: "temporary" }, { status: 503 });
        }
        return emptyResponse();
      }
      const body = bodyOf(init);
      calls.push({ body, method, url });
      if (url.endsWith("/v2/users/user/upload_prepare")) {
        return Response.json({
          block_size: String(firstSize),
          parts: [
            { block_size: String(firstSize), index: 0, presigned_url: "https://upload.example.test/part/0" },
            { block_size: String(bytes.byteLength - firstSize), index: 1, presigned_url: "https://upload.example.test/part/1" },
          ],
          upload_config: { concurrency: 2, retry_delay: 0, retry_timeout: 1 },
          upload_id: "multipart-1",
        });
      }
      if (url.endsWith("/v2/users/user/upload_part_finish")) {
        return Response.json({});
      }
      if (url.endsWith("/v2/users/user/files")) {
        return Response.json({ file_info: "merged-file", ttl: 3600 });
      }
      if (url.endsWith("/v2/users/user/messages")) {
        return Response.json({ id: "sent-media" });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await createAdapter().postMessage("qq:c2c/user", {
      attachments: [{ data: bytes, name: "archive.zip", type: "file" }],
      raw: "archive",
    });

    const prepare = calls.find((call) => call.url.endsWith("/upload_prepare"))!;
    assert.strictEqual(prepare.body?.file_size, String(bytes.byteLength));
    assert.strictEqual(prepare.body?.file_name, "archive.zip");
    assert.match(String(prepare.body?.md5), /^[a-f0-9]{32}$/);
    assert.match(String(prepare.body?.sha1), /^[a-f0-9]{40}$/);
    assert.match(String(prepare.body?.md5_10m), /^[a-f0-9]{32}$/);
    assert.deepStrictEqual(
      calls.filter((call) => call.url.endsWith("/upload_part_finish")).map((call) => call.body?.part_index).sort(),
      [0, 1],
    );
    assert.deepStrictEqual(calls.find((call) => call.url.endsWith("/files"))?.body, {
      file_name: "archive.zip",
      file_type: 4,
      srv_send_msg: false,
      upload_id: "multipart-1",
    });
    assert.deepStrictEqual(calls.find((call) => call.url.endsWith("/messages"))?.body, {
      content: "archive",
      media: { file_info: "merged-file", ttl: 3600 },
      msg_type: 7,
    });
    assert.strictEqual(firstPartAttempts, 2);
  });

  it("scopes media upload caches to the destination conversation", async () => {
    const uploads: string[] = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      if (url.endsWith("/files")) {
        uploads.push(url);
        const userId = url.includes("user-a") ? "user-a" : "user-b";
        return Response.json({ file_info: `file-${userId}`, ttl: 3600 });
      }
      return Response.json({ id: "sent" });
    }) as typeof fetch;

    const adapter = createAdapter();
    const message = {
      attachments: [{ data: Buffer.from("same-image"), name: "image.png", type: "image" as const }],
      raw: "image",
    };
    await adapter.postMessage("qq:c2c/user-a", message);
    await adapter.postMessage("qq:c2c/user-b", message);

    assert.deepStrictEqual(uploads, [
      "https://api.bot.qq.com/v2/users/user-a/files",
      "https://api.bot.qq.com/v2/users/user-b/files",
    ]);
  });

  it("does not retry multipart permission failures", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 9);
    let partAttempts = 0;
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      if (url.endsWith("/upload_prepare")) {
        return Response.json({
          parts: [{
            block_size: String(bytes.byteLength),
            index: 0,
            presigned_url: "https://upload.example.test/forbidden-part",
          }],
          upload_config: { retry_delay: 0, retry_timeout: 30 },
          upload_id: "multipart-forbidden",
        });
      }
      if (url === "https://upload.example.test/forbidden-part") {
        partAttempts += 1;
        return Response.json({ message: "forbidden" }, { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await assert.rejects(createAdapter().postMessage("qq:c2c/user", {
      attachments: [{ data: bytes, name: "archive.zip", type: "file" }],
      raw: "archive",
    }), { code: "PERMISSION_DENIED" });
    assert.strictEqual(partAttempts, 1);
  });

  it("manages global menus and command panels", async () => {
    const calls: Array<{ body: Record<string, unknown>; method: string; url: string }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      const method = init?.method ?? "GET";
      calls.push({ body: bodyOf(init), method, url });
      if (url.endsWith("/v2/menu") && method === "GET") {
        return Response.json({ version: 3, menu: { items: [] } });
      }
      if (url.endsWith("/v2/menu") && method === "PUT") return Response.json({ version: 4 });
      if (url.endsWith("/v2/panels?cursor=c1&limit=2&scope=group")) {
        return Response.json({ is_end: true, next_cursor: "", records: [] });
      }
      if (url.endsWith("/v2/panels") && method === "POST") return Response.json({ panel_id: "panel-1" });
      if (url.endsWith("/v2/panels/panel-1") && method === "GET") {
        return Response.json({
          panel_id: "panel-1",
          panel: { items: [] },
          scope: "group",
          target_type: "all",
        });
      }
      if (url.endsWith("/v2/panels/panel-1") && method === "PUT") return Response.json({ version: 2 });
      if (url.endsWith("/v2/panels/panel-1") && method === "DELETE") return emptyResponse();
      if (url.endsWith("/v2/panels/panel-1/target")) return emptyResponse();
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    const adapter = createAdapter();
    await adapter.getQQMenu();
    await adapter.updateQQMenu({ items: [{ name: "/help", send_message: "/help", type: "send_message" }] });
    await adapter.listQQCommandPanels("group", { cursor: "c1", limit: 2 });
    await adapter.createQQCommandPanel({
      panel: { items: [{ name: "/help", type: "command" }] },
      scope: "group",
      target_type: "all",
    });
    await adapter.getQQCommandPanel("panel-1");
    await adapter.updateQQCommandPanel("panel-1", { items: [{ name: "/help", type: "command" }] });
    await adapter.updateQQCommandPanelTargets("panel-1", {
      group_openids: ["group-2"],
      op: "add",
    });
    await adapter.deleteQQCommandPanel("panel-1");

    assert.deepStrictEqual(calls.map(({ method, url }) => `${method} ${url}`), [
      "GET https://api.bot.qq.com/v2/menu",
      "PUT https://api.bot.qq.com/v2/menu",
      "GET https://api.bot.qq.com/v2/panels?cursor=c1&limit=2&scope=group",
      "POST https://api.bot.qq.com/v2/panels",
      "GET https://api.bot.qq.com/v2/panels/panel-1",
      "PUT https://api.bot.qq.com/v2/panels/panel-1",
      "PUT https://api.bot.qq.com/v2/panels/panel-1/target",
      "DELETE https://api.bot.qq.com/v2/panels/panel-1",
    ]);
    assert.deepStrictEqual(calls[1]?.body, {
      menu: { items: [{ name: "/help", send_message: "/help", type: "send_message" }] },
    });
    assert.deepStrictEqual(calls[3]?.body, {
      panel: { items: [{ name: "/help", type: "command" }] },
      scope: "group",
      target_type: "all",
    });
    assert.deepStrictEqual(calls.find((call) => call.url.endsWith("/panel-1/target"))?.body, {
      group_openids: ["group-2"],
      op: "add",
    });
  });

  it("exposes every documented group management operation", async () => {
    const calls: Array<{ body: Record<string, unknown>; method: string; url: string }> = [];
    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      const method = init?.method ?? "GET";
      calls.push({ body: bodyOf(init), method, url });
      if (url.endsWith("/whitelist_users")) {
        return Response.json({ strategy_id: "strategy-1", whitelist_user_count: 2 });
      }
      if (method === "DELETE" || (method === "POST" && !url.endsWith("/join_approval_strategy"))) {
        return emptyResponse();
      }
      if (url.endsWith("/join_approval_strategy") && method === "POST") {
        return Response.json({ is_enable: "on", strategy_id: "strategy-1" });
      }
      if (url.endsWith("/v2/groups/group/info")) {
        return Response.json({ group_openid: "group", group_name: "Group" });
      }
      return Response.json({});
    }) as typeof fetch;

    const adapter = createAdapter();
    await adapter.getQQGroupInfo("qq:group/group");
    await adapter.getQQGroupBotState("group");
    await adapter.listQQGroupMembers("group", { cursor: "m1" });
    await adapter.getQQGroupMember("group", "member");
    await adapter.removeQQGroupMembers("group", { member_openids: ["member"] });
    await adapter.listQQGroupMemberBlacklist("group", { cursor: "b1", limit: 20 });
    await adapter.updateQQGroupMemberBlacklist("group", { member_openids: ["member"], op: "del" });
    await adapter.getQQGroupMuteState("group");
    await adapter.updateQQGroupMemberMute("group", {
      members: [{ member_openid: "member", mute_expire_at: "2026-11-01T00:00:00Z", op: "add" }],
    });
    await adapter.listQQGroupJoinRequests("group", { cursor: "j1", limit: 20 });
    await adapter.reviewQQGroupJoinRequest("group", "member", {
      join_request_id: "request-1",
      op: "approve",
    });
    await adapter.listQQGroupJoinApprovalStrategies({ cursor: "s1", limit: 20 });
    await adapter.createQQGroupJoinApprovalStrategy({ group_openids: ["group"], is_enable: "on" });
    await adapter.updateQQGroupJoinApprovalStrategy("strategy-1", { is_enable: "off" });
    await adapter.executeQQGroupJoinApprovalStrategy("strategy-1");
    const whitelist = await adapter.updateQQGroupJoinApprovalStrategyWhitelist("strategy-1", {
      op: "add",
      whitelist_users: ["10001", "10002"],
    });
    await adapter.deleteQQGroupJoinApprovalStrategy("strategy-1");

    assert.strictEqual(whitelist.whitelist_user_count, 2);
    assert.deepStrictEqual(calls.map(({ method, url }) => `${method} ${url}`), [
      "GET https://api.bot.qq.com/v2/groups/group/info",
      "GET https://api.bot.qq.com/v2/groups/group/bot_state",
      "GET https://api.bot.qq.com/v2/groups/group/members?cursor=m1",
      "GET https://api.bot.qq.com/v2/groups/group/members/member",
      "POST https://api.bot.qq.com/v2/groups/group/batch_remove_members",
      "GET https://api.bot.qq.com/v2/groups/group/member_blacklist?cursor=b1&limit=20",
      "POST https://api.bot.qq.com/v2/groups/group/member_blacklist",
      "GET https://api.bot.qq.com/v2/groups/group/restrict_chat_setting",
      "POST https://api.bot.qq.com/v2/groups/group/restrict_chat_setting",
      "GET https://api.bot.qq.com/v2/groups/group/join_request_list?cursor=j1&limit=20",
      "POST https://api.bot.qq.com/v2/groups/group/approval_join_request/member",
      "GET https://api.bot.qq.com/v2/groups/join_approval_strategy?cursor=s1&limit=20",
      "POST https://api.bot.qq.com/v2/groups/join_approval_strategy",
      "PATCH https://api.bot.qq.com/v2/groups/join_approval_strategy/strategy-1",
      "POST https://api.bot.qq.com/v2/groups/join_approval_strategy/strategy-1/execute",
      "POST https://api.bot.qq.com/v2/groups/join_approval_strategy/strategy-1/whitelist_users",
      "DELETE https://api.bot.qq.com/v2/groups/join_approval_strategy/strategy-1",
    ]);
    assert.deepStrictEqual(
      calls.find((call) => call.url.endsWith("/batch_remove_members"))?.body,
      { member_openids: ["member"] },
    );
    assert.deepStrictEqual(
      calls.find((call) => call.url.endsWith("/member_blacklist") && call.method === "POST")?.body,
      { member_openids: ["member"], op: "del" },
    );
    assert.deepStrictEqual(
      calls.find((call) => call.url.endsWith("/approval_join_request/member"))?.body,
      { join_request_id: "request-1", op: "approve" },
    );
    assert.deepStrictEqual(
      calls.find((call) => call.url.endsWith("/strategy-1/execute"))?.body,
      {},
    );
  });

  it("dispatches subscription authorization changes and generates share links", async () => {
    const adapter = createAdapter();
    const listener = mock.fn();
    await adapter.initialize({} as ChatInstance);
    adapter.onEvent("SUBSCRIBE_MESSAGE_STATUS", listener);
    await adapter.handleSocketModePayload({
      op: 0,
      t: "SUBSCRIBE_MESSAGE_STATUS",
      d: {
        openid: "user",
        result: [{
          op: 1,
          subscribe_id: "subscribe-1",
          template_id: 42,
          subscribe_ts: 1,
          update_ts: 2,
        }],
      },
    });

    assert.strictEqual(listener.mock.callCount(), 1);
    assert.strictEqual(listener.mock.calls[0]?.arguments[0].threadId, "qq:c2c/user");
    assert.strictEqual(
      listener.mock.calls[0]?.arguments[0].data.result[0].subscribe_id,
      "subscribe-1",
    );

    globalThis.fetch = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = tokenResponse(url);
      if (token) return token;
      assert.strictEqual(bodyOf(init).callback_data, "open:help");
      return Response.json({ data: { url: "https://qq.example/link" } });
    }) as typeof fetch;
    const link = await createAdapter().generateQQUrlLink("open:help");
    assert.strictEqual(link.data.url, "https://qq.example/link");
  });
});
