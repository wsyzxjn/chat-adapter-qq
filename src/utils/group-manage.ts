import { ChatError } from "chat";
import {
  QQ_GROUP_JOIN_APPROVAL_STRATEGY_MAX_GROUPS,
  QQ_GROUP_JOIN_APPROVAL_WHITELIST_BATCH_LIMIT,
  QQ_GROUP_JOIN_REQUEST_DEFAULT_LIMIT,
  QQ_GROUP_JOIN_REQUEST_MAX_LIMIT,
  QQ_GROUP_MUTE_MEMBER_BATCH_LIMIT,
} from "../constants.js";
import type {
  QQApproveGroupJoinRequestOptions,
  QQCreateGroupJoinApprovalStrategyRequest,
  QQGroupJoinApprovalStrategyGroupAction,
  QQGroupListQuery,
  QQGroupMuteMemberOp,
  QQSetGroupMemberMuteRequest,
  QQUpdateGroupJoinApprovalStrategyRequest,
  QQUpdateGroupJoinApprovalWhitelistRequest,
} from "../types.js";
import { decodeThreadId } from "./thread-id.js";

const MUTE_MEMBER_OPS = new Set(["add", "update", "del"]);
const JOIN_REQUEST_OPS = new Set(["approve", "decline"]);
const ENABLE_FLAGS = new Set(["on", "off"]);
const GROUP_ACTION_OPS = new Set(["add", "del"]);
const WHITELIST_OPS = new Set(["add", "del"]);

/**
 * Accept a Chat thread id (`qq:group/<group_openid>`) or a raw group openid.
 */
export function resolveGroupOpenId(adapterName: string, group: string): string {
  const trimmed = group.trim();
  if (!trimmed) {
    throw new ChatError("QQ group identifier is required.", "INVALID_REQUEST");
  }
  if (!trimmed.startsWith(`${adapterName}:`)) {
    return trimmed;
  }

  let thread;
  try {
    thread = decodeThreadId(adapterName, trimmed);
  } catch {
    throw new ChatError(`Invalid QQ group identifier: ${group}`, "INVALID_REQUEST");
  }
  if (thread.type !== "group") {
    throw new ChatError("QQ group management APIs require a group thread id or group_openid.", "INVALID_REQUEST");
  }
  return thread.groupOpenId;
}

export function getGroupMuteSettingPath(groupOpenId: string): string {
  return `/v2/groups/${encodeURIComponent(groupOpenId)}/restrict_chat_setting`;
}

export function getGroupJoinRequestListPath(groupOpenId: string, query: QQGroupListQuery = {}): string {
  return withCursorLimitQuery(`/v2/groups/${encodeURIComponent(groupOpenId)}/join_request_list`, query);
}

export function getApproveGroupJoinRequestPath(groupOpenId: string, memberOpenId: string): string {
  return `/v2/groups/${encodeURIComponent(groupOpenId)}/approval_join_request/${encodeURIComponent(memberOpenId)}`;
}

export function getGroupJoinApprovalStrategyListPath(query: QQGroupListQuery = {}): string {
  return withCursorLimitQuery("/v2/groups/join_approval_strategy", query);
}

export function getGroupJoinApprovalStrategyCollectionPath(): string {
  return "/v2/groups/join_approval_strategy";
}

export function getGroupJoinApprovalStrategyPath(strategyId: string): string {
  return `/v2/groups/join_approval_strategy/${encodeURIComponent(assertNonEmptyString(strategyId, "strategy_id"))}`;
}

export function getExecuteGroupJoinApprovalStrategyPath(strategyId: string): string {
  return `${getGroupJoinApprovalStrategyPath(strategyId)}/execute`;
}

export function getGroupJoinApprovalWhitelistPath(strategyId: string): string {
  return `${getGroupJoinApprovalStrategyPath(strategyId)}/whitelist_users`;
}

export function buildSetGroupMemberMuteRequest(members: readonly QQGroupMuteMemberOp[]): QQSetGroupMemberMuteRequest {
  if (!Array.isArray(members) || members.length === 0) {
    throw new ChatError("setGroupMemberMute requires at least one member operation.", "INVALID_REQUEST");
  }
  if (members.length > QQ_GROUP_MUTE_MEMBER_BATCH_LIMIT) {
    throw new ChatError(
      `setGroupMemberMute accepts at most ${QQ_GROUP_MUTE_MEMBER_BATCH_LIMIT} members per request.`,
      "INVALID_REQUEST",
    );
  }

  return {
    members: members.map((member, index) => {
      if (!member || typeof member !== "object") {
        throw new ChatError(`setGroupMemberMute members[${index}] must be an object.`, "INVALID_REQUEST");
      }
      if (!MUTE_MEMBER_OPS.has(member.op)) {
        throw new ChatError(`setGroupMemberMute members[${index}].op must be add, update, or del.`, "INVALID_REQUEST");
      }
      const memberOpenId = assertNonEmptyString(member.member_openid, `members[${index}].member_openid`);
      if (member.op === "add" || member.op === "update") {
        const muteExpireAt = assertNonEmptyString(member.mute_expire_at, `members[${index}].mute_expire_at`);
        return {
          member_openid: memberOpenId,
          mute_expire_at: muteExpireAt,
          op: member.op,
        };
      }
      return {
        member_openid: memberOpenId,
        op: member.op,
      };
    }),
  };
}

export function buildApproveGroupJoinRequestBody(
  memberOpenId: string,
  options: QQApproveGroupJoinRequestOptions,
): QQApproveGroupJoinRequestOptions {
  assertNonEmptyString(memberOpenId, "member_openid");
  if (!options || typeof options !== "object") {
    throw new ChatError("approveGroupJoinRequest options are required.", "INVALID_REQUEST");
  }
  if (!JOIN_REQUEST_OPS.has(options.op)) {
    throw new ChatError("approveGroupJoinRequest op must be approve or decline.", "INVALID_REQUEST");
  }
  const joinRequestId = assertNonEmptyString(options.join_request_id, "join_request_id");
  if (options.op === "approve") {
    if (options.reject_reason !== undefined || options.add_to_member_blacklist !== undefined) {
      throw new ChatError(
        "reject_reason and add_to_member_blacklist are only valid when declining a join request.",
        "INVALID_REQUEST",
      );
    }
    return {
      join_request_id: joinRequestId,
      op: "approve",
    };
  }

  const body: QQApproveGroupJoinRequestOptions = {
    join_request_id: joinRequestId,
    op: "decline",
  };
  if (options.reject_reason !== undefined) {
    body.reject_reason = assertNonEmptyString(options.reject_reason, "reject_reason");
  }
  if (options.add_to_member_blacklist !== undefined) {
    if (typeof options.add_to_member_blacklist !== "boolean") {
      throw new ChatError("add_to_member_blacklist must be a boolean.", "INVALID_REQUEST");
    }
    body.add_to_member_blacklist = options.add_to_member_blacklist;
  }
  return body;
}

export function buildCreateGroupJoinApprovalStrategyRequest(
  data: QQCreateGroupJoinApprovalStrategyRequest,
): QQCreateGroupJoinApprovalStrategyRequest {
  if (!data || typeof data !== "object") {
    throw new ChatError("createGroupJoinApprovalStrategy body is required.", "INVALID_REQUEST");
  }

  const groupOpenIds = optionalStringList(data.group_openids, "group_openids");
  const groupIds = optionalStringList(data.group_ids, "group_ids");
  assertExclusiveGroupLists(groupOpenIds, groupIds);

  const body: QQCreateGroupJoinApprovalStrategyRequest = {};
  if (groupOpenIds) {
    body.group_openids = groupOpenIds;
  }
  if (groupIds) {
    body.group_ids = groupIds;
  }
  if (data.is_enable !== undefined) {
    body.is_enable = assertEnableFlag(data.is_enable, "is_enable");
  }
  if (data.expire_at !== undefined) {
    body.expire_at = assertNonEmptyString(data.expire_at, "expire_at");
  }
  if (data.remark !== undefined) {
    body.remark = assertNonEmptyString(data.remark, "remark");
  }
  return body;
}

export function buildUpdateGroupJoinApprovalStrategyRequest(
  data: QQUpdateGroupJoinApprovalStrategyRequest,
): QQUpdateGroupJoinApprovalStrategyRequest {
  if (!data || typeof data !== "object") {
    throw new ChatError("updateGroupJoinApprovalStrategy body is required.", "INVALID_REQUEST");
  }

  const body: QQUpdateGroupJoinApprovalStrategyRequest = {};
  if (data.is_enable !== undefined) {
    body.is_enable = assertEnableFlag(data.is_enable, "is_enable");
  }
  if (data.expire_at !== undefined) {
    body.expire_at = assertNonEmptyString(data.expire_at, "expire_at");
  }
  if (data.remark !== undefined) {
    body.remark = assertNonEmptyString(data.remark, "remark");
  }
  if (data.group_action !== undefined) {
    body.group_action = buildGroupAction(data.group_action);
  }
  if (
    body.is_enable === undefined &&
    body.expire_at === undefined &&
    body.remark === undefined &&
    body.group_action === undefined
  ) {
    throw new ChatError("updateGroupJoinApprovalStrategy requires at least one field to update.", "INVALID_REQUEST");
  }
  return body;
}

export function buildUpdateGroupJoinApprovalWhitelistRequest(
  data: QQUpdateGroupJoinApprovalWhitelistRequest,
): QQUpdateGroupJoinApprovalWhitelistRequest {
  if (!data || typeof data !== "object") {
    throw new ChatError("updateGroupJoinApprovalWhitelist body is required.", "INVALID_REQUEST");
  }
  if (!WHITELIST_OPS.has(data.op)) {
    throw new ChatError("updateGroupJoinApprovalWhitelist op must be add or del.", "INVALID_REQUEST");
  }
  if (!Array.isArray(data.whitelist_users) || data.whitelist_users.length === 0) {
    throw new ChatError("whitelist_users must be a non-empty array of QQ number strings.", "INVALID_REQUEST");
  }
  if (data.whitelist_users.length > QQ_GROUP_JOIN_APPROVAL_WHITELIST_BATCH_LIMIT) {
    throw new ChatError(
      `whitelist_users accepts at most ${QQ_GROUP_JOIN_APPROVAL_WHITELIST_BATCH_LIMIT} entries per request.`,
      "INVALID_REQUEST",
    );
  }

  return {
    op: data.op,
    whitelist_users: data.whitelist_users.map((user, index) => {
      if (typeof user !== "string") {
        throw new ChatError(
          `whitelist_users[${index}] must be a string QQ number (avoid number precision loss).`,
          "INVALID_REQUEST",
        );
      }
      return assertNonEmptyString(user, `whitelist_users[${index}]`);
    }),
  };
}

function withCursorLimitQuery(path: string, query: QQGroupListQuery): string {
  const params = new URLSearchParams();
  if (query.cursor !== undefined && query.cursor !== "") {
    params.set("cursor", assertNonEmptyString(query.cursor, "cursor"));
  }
  params.set("limit", String(normalizeListLimit(query.limit)));
  return `${path}?${params.toString()}`;
}

function normalizeListLimit(limit: number | undefined): number {
  const value = limit ?? QQ_GROUP_JOIN_REQUEST_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > QQ_GROUP_JOIN_REQUEST_MAX_LIMIT) {
    throw new ChatError(
      `limit must be an integer between 1 and ${QQ_GROUP_JOIN_REQUEST_MAX_LIMIT}.`,
      "INVALID_REQUEST",
    );
  }
  return value;
}

function buildGroupAction(action: QQGroupJoinApprovalStrategyGroupAction): QQGroupJoinApprovalStrategyGroupAction {
  if (!action || typeof action !== "object") {
    throw new ChatError("group_action must be an object.", "INVALID_REQUEST");
  }
  if (!GROUP_ACTION_OPS.has(action.op)) {
    throw new ChatError("group_action.op must be add or del.", "INVALID_REQUEST");
  }
  const groupOpenIds = optionalStringList(action.group_openids, "group_action.group_openids");
  const groupIds = optionalStringList(action.group_ids, "group_action.group_ids");
  assertExclusiveGroupLists(groupOpenIds, groupIds);
  const body: QQGroupJoinApprovalStrategyGroupAction = { op: action.op };
  if (groupOpenIds) {
    body.group_openids = groupOpenIds;
  }
  if (groupIds) {
    body.group_ids = groupIds;
  }
  return body;
}

function assertExclusiveGroupLists(groupOpenIds: string[] | undefined, groupIds: string[] | undefined): void {
  const hasOpenIds = groupOpenIds !== undefined && groupOpenIds.length > 0;
  const hasGroupIds = groupIds !== undefined && groupIds.length > 0;
  if (hasOpenIds === hasGroupIds) {
    throw new ChatError("Provide exactly one of group_openids or group_ids.", "INVALID_REQUEST");
  }
  const groups = hasOpenIds ? groupOpenIds : groupIds;
  if (groups && groups.length > QQ_GROUP_JOIN_APPROVAL_STRATEGY_MAX_GROUPS) {
    throw new ChatError(
      `A join approval strategy can associate at most ${QQ_GROUP_JOIN_APPROVAL_STRATEGY_MAX_GROUPS} groups.`,
      "INVALID_REQUEST",
    );
  }
}

function optionalStringList(value: string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ChatError(`${field} must be a non-empty string array when provided.`, "INVALID_REQUEST");
  }
  return value.map((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
}

function assertEnableFlag(value: string, field: string): "on" | "off" {
  if (!ENABLE_FLAGS.has(value)) {
    throw new ChatError(`${field} must be on or off.`, "INVALID_REQUEST");
  }
  return value as "on" | "off";
}

function assertNonEmptyString(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ChatError(`${field} is required.`, "INVALID_REQUEST");
  }
  return value;
}
