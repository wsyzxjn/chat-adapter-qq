import type { ChatInstance, Logger } from "chat";
import { ChatError } from "chat";
import { QQAdapter } from "@amatsuka/chat-adapter-qq";
import type { QQSocketModeAdapterConfig, QQWebhookAdapterConfig } from "@amatsuka/chat-adapter-qq";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const APP_ID = "11111111";
const BOT_SECRET = "DG5g3B4j9X2KOErG";
const TOKEN_ENDPOINT = "https://tokens.example.test/app/getAppAccessToken";
const GROUP_OPENID = "30584554AA2BF4E72BD3B8F27A70339D";
const MEMBER_OPENID = "FE003FAF76C4817251FDC128A16753BB";
const JOIN_REQUEST_ID =
  "AVKiFWpdy0-q0rfCkpQFbWB9GvX7QPIe9hlsbVeO6TiurrZw1DHP0sXGnbUR4Xm79tKNpfl4zZynxeibVwwUD6h96RqiFB-4V6p5FKGXfqInOuQQSf5WwXr8lyIsn6yeaMwEI1KSuTTMBMNe6WN8bDtKg2REXTcF";

type TestQQAdapterConfig =
  | (Partial<Omit<QQSocketModeAdapterConfig, "appId" | "clientSecret" | "mode">> & { mode: "socket" })
  | Partial<Omit<QQWebhookAdapterConfig, "appId" | "clientSecret">>;

function createAdapter(config: TestQQAdapterConfig = {}): QQAdapter {
  return new QQAdapter({
    appId: APP_ID,
    clientSecret: BOT_SECRET,
    logger: createSilentLogger(),
    tokenEndpoint: TOKEN_ENDPOINT,
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

async function initializeWithProcessSpy(adapter: QQAdapter) {
  const processMessage = mock.fn();
  await adapter.initialize({ processMessage } as unknown as ChatInstance);
  return processMessage;
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

function mockQqApi(
  handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const fetchMock = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_ENDPOINT) {
      return Response.json({
        access_token: "access-token",
        expires_in: 7200,
      });
    }
    const handler = handlers[url];
    if (handler) {
      return handler(init);
    }
    return Response.json({ code: 404, message: "not found" }, { status: 404 });
  });
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return fetchMock;
}

async function assertChatError(
  promise: Promise<unknown>,
  code: string,
  messagePattern?: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ChatError, "expected ChatError");
    assert.equal(error.code, code);
    if (messagePattern) {
      assert.match(error.message, messagePattern);
    }
    return true;
  });
}

const _fetch = globalThis.fetch;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = _fetch;
});

const JOIN_REQUEST_EVENT = {
  apply_at: "2026-08-05T17:32:52+08:00",
  apply_source: "self_apply",
  auto_approved: {
    strategy_id: "st_7c0b77d442",
  },
  group_openid: GROUP_OPENID,
  join_request_id: JOIN_REQUEST_ID,
  member_openid: MEMBER_OPENID,
  username: "痞孓小光光╮hw灰",
  verify_info: {
    method: "verify_message",
    verify_message: "健健康康",
  },
};

describe("QQAdapter group management APIs", () => {
  it("queries group mute setting by thread id or group openid", async () => {
    const setting = {
      global_rule: { mode: "none" },
      members: [
        {
          member_openid: MEMBER_OPENID,
          mute_expire_at: "2026-08-12T12:00:00+08:00",
          username: "ordinary-member",
        },
      ],
    };
    const fetchMock = mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`]: () =>
        Response.json(setting),
    });
    const adapter = createAdapter();

    const byThread = await adapter.getGroupMuteSetting(`qq:group/${GROUP_OPENID}`);
    const byOpenId = await adapter.getGroupMuteSetting(GROUP_OPENID);

    assert.deepStrictEqual(byThread, setting);
    assert.deepStrictEqual(byOpenId, setting);
    assert.equal(fetchMock.mock.callCount(), 3);
    assert.equal(
      String(fetchMock.mock.calls[1]?.arguments[0]),
      `https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`,
    );
    assert.equal((fetchMock.mock.calls[1]?.arguments[1] as RequestInit).method, "GET");
  });

  it("sets and unsets member mute in batches of at most 10", async () => {
    const fetchMock = mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`]: () =>
        Response.json({}),
    });
    const adapter = createAdapter();

    await adapter.setGroupMemberMute(GROUP_OPENID, [
      {
        member_openid: MEMBER_OPENID,
        mute_expire_at: "2026-08-12T12:00:00+08:00",
        op: "add",
      },
      {
        member_openid: "DE538D0B23260BFEC30EA4A17C3A71B1",
        op: "del",
      },
    ]);

    assert.deepStrictEqual(requestJsonBody(fetchMock.mock.calls[1]!), {
      members: [
        {
          member_openid: MEMBER_OPENID,
          mute_expire_at: "2026-08-12T12:00:00+08:00",
          op: "add",
        },
        {
          member_openid: "DE538D0B23260BFEC30EA4A17C3A71B1",
          op: "del",
        },
      ],
    });

    await assertChatError(
      adapter.setGroupMemberMute(GROUP_OPENID, Array.from({ length: 11 }, (_, index) => ({
        member_openid: `member-${index}`,
        mute_expire_at: "2026-08-12T12:00:00+08:00",
        op: "add" as const,
      }))),
      "INVALID_REQUEST",
      /at most 10/,
    );
    await assertChatError(
      adapter.setGroupMemberMute(GROUP_OPENID, [{ member_openid: MEMBER_OPENID, op: "add" }]),
      "INVALID_REQUEST",
      /mute_expire_at/,
    );
    await assertChatError(
      adapter.setGroupMemberMute("qq:c2c/user-openid", [{ member_openid: MEMBER_OPENID, op: "del" }]),
      "INVALID_REQUEST",
      /group thread id or group_openid/,
    );
  });

  it("lists join requests with cursor/limit pagination", async () => {
    const page = {
      list: [
        {
          apply_at: "2026-08-05T16:21:40+08:00",
          apply_source: "self_apply",
          join_request_id: JOIN_REQUEST_ID,
          member_openid: MEMBER_OPENID,
          username: "申请人",
          verify_info: {
            method: "verify_message",
            verify_message: "就快乐了",
          },
        },
      ],
      next_cursor: "",
    };
    const fetchMock = mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/join_request_list?cursor=abc&limit=50`]: () =>
        Response.json(page),
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/join_request_list?limit=20`]: () =>
        Response.json({ list: [], next_cursor: "" }),
    });
    const adapter = createAdapter();

    const result = await adapter.getGroupJoinRequests(`qq:group/${GROUP_OPENID}`, {
      cursor: "abc",
      limit: 50,
    });
    assert.deepStrictEqual(result, page);

    await adapter.getGroupJoinRequests(GROUP_OPENID);
    assert.equal(
      String(fetchMock.mock.calls[2]?.arguments[0]),
      `https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/join_request_list?limit=20`,
    );

    await assertChatError(
      adapter.getGroupJoinRequests(GROUP_OPENID, { limit: 101 }),
      "INVALID_REQUEST",
      /between 1 and 100/,
    );
  });

  it("approves and declines join requests, including reject_reason and blacklist", async () => {
    const path =
      `https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/approval_join_request/${MEMBER_OPENID}`;
    const fetchMock = mockQqApi({
      [path]: () => Response.json({}),
    });
    const adapter = createAdapter();

    await adapter.approveGroupJoinRequest(GROUP_OPENID, MEMBER_OPENID, {
      join_request_id: JOIN_REQUEST_ID,
      op: "approve",
    });
    assert.deepStrictEqual(requestJsonBody(fetchMock.mock.calls[1]!), {
      join_request_id: JOIN_REQUEST_ID,
      op: "approve",
    });

    await adapter.approveGroupJoinRequest(`qq:group/${GROUP_OPENID}`, MEMBER_OPENID, {
      add_to_member_blacklist: true,
      join_request_id: JOIN_REQUEST_ID,
      op: "decline",
      reject_reason: "未通过入群验证",
    });
    assert.deepStrictEqual(requestJsonBody(fetchMock.mock.calls[2]!), {
      add_to_member_blacklist: true,
      join_request_id: JOIN_REQUEST_ID,
      op: "decline",
      reject_reason: "未通过入群验证",
    });

    await assertChatError(
      adapter.approveGroupJoinRequest(GROUP_OPENID, MEMBER_OPENID, {
        join_request_id: JOIN_REQUEST_ID,
        op: "approve",
        reject_reason: "nope",
      }),
      "INVALID_REQUEST",
      /only valid when declining/,
    );
  });

  it("maps group-admin permission failures through ChatError", async () => {
    mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`]: () =>
        Response.json({ code: 11282, message: "ErrorCheckAdminNotPass" }, { status: 403 }),
    });
    const adapter = createAdapter();
    await assertChatError(
      adapter.getGroupMuteSetting(GROUP_OPENID),
      "PERMISSION_DENIED",
      /code=11282/,
    );
  });

  it("maps err_code-only admin failures without HTTP 403", async () => {
    mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`]: () =>
        Response.json({ err_code: 11282, message: "ErrorCheckAdminNotPass" }, { status: 400 }),
    });
    const adapter = createAdapter();
    await assertChatError(
      adapter.getGroupMuteSetting(GROUP_OPENID),
      "PERMISSION_DENIED",
      /code=11282/,
    );
  });

  it("maps IP whitelist 11298 as PERMISSION_DENIED, distinct from admin failure", async () => {
    mockQqApi({
      [`https://api.sgroup.qq.com/v2/groups/${GROUP_OPENID}/restrict_chat_setting`]: () =>
        Response.json({ code: 11298, message: "ip not in whitelist" }, { status: 403 }),
    });
    const adapter = createAdapter();
    await assertChatError(
      adapter.getGroupMuteSetting(GROUP_OPENID),
      "PERMISSION_DENIED",
      /code=11298/,
    );
  });

  it("creates, lists, updates, executes, whitelists, and deletes join approval strategies", async () => {
    const fetchMock = mockQqApi({
      "https://api.sgroup.qq.com/v2/groups/join_approval_strategy?limit=20": () =>
        Response.json({
          next_cursor: "",
          strategies: [{ is_enable: "on", strategy_id: "st_7c0b77d442" }],
        }),
      "https://api.sgroup.qq.com/v2/groups/join_approval_strategy": (init) => {
        if (init?.method === "POST") {
          return Response.json({
            expire_at: "2026-09-01T00:00:00+08:00",
            is_enable: "on",
            strategy_id: "st_7c0b77d442",
          });
        }
        return Response.json({ code: 404 }, { status: 404 });
      },
      "https://api.sgroup.qq.com/v2/groups/join_approval_strategy/st_7c0b77d442": (init) => {
        if (init?.method === "PATCH") {
          return Response.json({ is_enable: "off" });
        }
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({ code: 404 }, { status: 404 });
      },
      "https://api.sgroup.qq.com/v2/groups/join_approval_strategy/st_7c0b77d442/execute": () =>
        Response.json({}),
      "https://api.sgroup.qq.com/v2/groups/join_approval_strategy/st_7c0b77d442/whitelist_users": () =>
        Response.json({
          strategy_id: "st_7c0b77d442",
          whitelist_user_count: 2,
        }),
    });
    const adapter = createAdapter();

    const created = await adapter.createGroupJoinApprovalStrategy({
      group_openids: [GROUP_OPENID],
      is_enable: "on",
      remark: "活动白名单",
    });
    assert.equal(created.strategy_id, "st_7c0b77d442");
    assert.deepStrictEqual(requestJsonBody(fetchMock.mock.calls[1]!), {
      group_openids: [GROUP_OPENID],
      is_enable: "on",
      remark: "活动白名单",
    });

    const listed = await adapter.getGroupJoinApprovalStrategies();
    assert.equal(listed.strategies?.[0]?.strategy_id, "st_7c0b77d442");

    await adapter.updateGroupJoinApprovalStrategy("st_7c0b77d442", { is_enable: "off" });
    await adapter.updateGroupJoinApprovalWhitelist("st_7c0b77d442", {
      op: "add",
      whitelist_users: ["1234567", "1234568"],
    });
    await adapter.executeGroupJoinApprovalStrategy("st_7c0b77d442");
    await adapter.deleteGroupJoinApprovalStrategy("st_7c0b77d442");

    await assertChatError(
      adapter.createGroupJoinApprovalStrategy({
        group_ids: ["1"],
        group_openids: [GROUP_OPENID],
      }),
      "INVALID_REQUEST",
      /exactly one of group_openids or group_ids/,
    );
    await assertChatError(
      adapter.updateGroupJoinApprovalWhitelist("st_7c0b77d442", {
        op: "add",
        whitelist_users: [1234567 as unknown as string],
      }),
      "INVALID_REQUEST",
      /string QQ number/,
    );
  });
});

describe("QQAdapter GROUP_JOIN_REQUEST events", () => {
  it("dispatches GROUP_JOIN_REQUEST on webhook without processMessage", async () => {
    const adapter = createAdapter();
    const onEvent = mock.fn();
    adapter.onEvent("GROUP_JOIN_REQUEST", onEvent);
    const processMessage = await initializeWithProcessSpy(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.test/webhooks/qq", {
        body: JSON.stringify({
          d: JOIN_REQUEST_EVENT,
          id: "join-event-1",
          op: 0,
          s: 12,
          t: "GROUP_JOIN_REQUEST",
        }),
        headers: {
          "X-Bot-Appid": APP_ID,
        },
        method: "POST",
      }),
    );

    assert.equal(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      d: { seq: 12 },
      op: 12,
    });
    assert.equal(processMessage.mock.callCount(), 0);
    assert.equal(onEvent.mock.callCount(), 1);
    assertMatchObject(onEvent.mock.calls[0]?.arguments[0], {
      data: {
        auto_approved: {
          strategy_id: "st_7c0b77d442",
        },
        group_openid: GROUP_OPENID,
        join_request_id: JOIN_REQUEST_ID,
        member_openid: MEMBER_OPENID,
      },
      eventId: "join-event-1",
      threadId: `qq:group/${GROUP_OPENID}`,
      type: "GROUP_JOIN_REQUEST",
    });
  });

  it("dispatches GROUP_JOIN_REQUEST on socket mode with auto_approved.strategy_id", async () => {
    const adapter = createAdapter();
    const onEvent = mock.fn();
    adapter.onEvent("GROUP_JOIN_REQUEST", onEvent);

    await adapter.handleSocketModePayload({
      d: JOIN_REQUEST_EVENT,
      id: "join-event-socket",
      op: 0,
      t: "GROUP_JOIN_REQUEST",
    });

    assert.equal(onEvent.mock.callCount(), 1);
    assertMatchObject(onEvent.mock.calls[0]?.arguments[0], {
      data: {
        auto_approved: {
          strategy_id: "st_7c0b77d442",
        },
        verify_info: {
          method: "verify_message",
          verify_message: "健健康康",
        },
      },
      eventId: "join-event-socket",
      threadId: `qq:group/${GROUP_OPENID}`,
      type: "GROUP_JOIN_REQUEST",
    });
  });
});
