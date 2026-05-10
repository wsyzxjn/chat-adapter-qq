import type { QQThreadId, QQThreadType } from "../types.js";
import { assertNever } from "./assert.js";

export function encodeThreadId(adapterName: string, thread: QQThreadId): string {
  switch (thread.type) {
    case "c2c":
      return `${adapterName}:c2c/${encodeURIComponent(thread.userOpenId)}`;
    case "group":
      return `${adapterName}:group/${encodeURIComponent(thread.groupOpenId)}`;
    case "guild_channel":
      return `${adapterName}:guild/${encodeURIComponent(thread.guildId)}/${encodeURIComponent(thread.channelId)}`;
    default:
      return assertNever(thread);
  }
}

export function decodeThreadId(adapterName: string, threadId: string): QQThreadId {
  if (!threadId.startsWith(`${adapterName}:`)) {
    throw new Error(`Invalid QQ threadId: ${threadId}`);
  }

  const suffix = threadId.slice(adapterName.length + 1);
  if (suffix.startsWith("c2c/")) {
    const encodedId = suffix.slice("c2c/".length);
    if (encodedId) {
      return {
        type: "c2c",
        userOpenId: decodeURIComponent(encodedId),
      };
    }
  }
  if (suffix.startsWith("group/")) {
    const encodedId = suffix.slice("group/".length);
    if (encodedId) {
      return {
        groupOpenId: decodeURIComponent(encodedId),
        type: "group",
      };
    }
  }
  if (suffix.startsWith("guild/")) {
    const encodedIds = suffix.slice("guild/".length);
    const slash = encodedIds.indexOf("/");
    if (slash > 0) {
      const guildEncoded = encodedIds.slice(0, slash);
      const channelEncoded = encodedIds.slice(slash + 1);
      if (guildEncoded && channelEncoded) {
        return {
          channelId: decodeURIComponent(channelEncoded),
          guildId: decodeURIComponent(guildEncoded),
          type: "guild_channel",
        };
      }
    }
  }

  throw new Error(`Invalid QQ threadId: ${threadId}`);
}

export function toThreadStorageId(thread: QQThreadId): string {
  switch (thread.type) {
    case "group":
      return thread.groupOpenId;
    case "c2c":
      return thread.userOpenId;
    case "guild_channel":
      return `${encodeURIComponent(thread.guildId)}/${encodeURIComponent(thread.channelId)}`;
    default:
      return assertNever(thread);
  }
}

export function fromThreadStorage(type: QQThreadType, value: string): QQThreadId {
  switch (type) {
    case "group":
      return { groupOpenId: value, type: "group" };
    case "c2c":
      return { type: "c2c", userOpenId: value };
    case "guild_channel": {
      const slash = value.indexOf("/");
      if (slash <= 0) {
        throw new Error(`Invalid stored guild channel thread id: ${value}`);
      }
      return {
        channelId: decodeURIComponent(value.slice(slash + 1)),
        guildId: decodeURIComponent(value.slice(0, slash)),
        type: "guild_channel",
      };
    }
    default:
      return assertNever(type);
  }
}

export function toThreadMetadata(thread: QQThreadId): Record<string, unknown> {
  switch (thread.type) {
    case "group":
      return { groupOpenId: thread.groupOpenId, type: thread.type };
    case "c2c":
      return { type: thread.type, userOpenId: thread.userOpenId };
    case "guild_channel":
      return {
        channelId: thread.channelId,
        guildId: thread.guildId,
        type: thread.type,
      };
    default:
      return assertNever(thread);
  }
}

export function getChannelName(thread: QQThreadId): string {
  switch (thread.type) {
    case "group":
      return `QQ Group ${thread.groupOpenId}`;
    case "c2c":
      return "QQ Direct Message";
    case "guild_channel":
      return `QQ Guild ${thread.guildId}/${thread.channelId}`;
    default:
      return assertNever(thread);
  }
}
