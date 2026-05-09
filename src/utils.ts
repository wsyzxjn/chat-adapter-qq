import type { AdapterPostableMessage } from "chat";
import { ChatError, RateLimitError } from "chat";
import { QQFormatConverter } from "./format-converter.js";
import type { QQWebhookValidationData } from "./types.js";

type QQMappedErrorType = "AUTH_FAILED" | "NOT_FOUND" | "PERMISSION_DENIED" | "RATE_LIMIT";
const QQ_ERROR_CODE_MAP = new Map<number, QQMappedErrorType>([
  [22009, "RATE_LIMIT"],
  [11241, "AUTH_FAILED"],
  [11242, "AUTH_FAILED"],
  [11243, "AUTH_FAILED"],
  [11251, "AUTH_FAILED"],
  [11261, "AUTH_FAILED"],
  [11275, "AUTH_FAILED"],
  [11298, "PERMISSION_DENIED"],
  [11253, "PERMISSION_DENIED"],
  [11254, "PERMISSION_DENIED"],
  [11264, "PERMISSION_DENIED"],
  [11265, "PERMISSION_DENIED"],
  [304026, "PERMISSION_DENIED"],
  [304027, "PERMISSION_DENIED"],
  [304028, "PERMISSION_DENIED"],
  [304031, "PERMISSION_DENIED"],
  [304045, "PERMISSION_DENIED"],
  [304046, "PERMISSION_DENIED"],
  [304047, "PERMISSION_DENIED"],
  [304048, "PERMISSION_DENIED"],
  [304049, "PERMISSION_DENIED"],
  [304050, "PERMISSION_DENIED"],
  [50045, "PERMISSION_DENIED"],
  [50046, "PERMISSION_DENIED"],
  [50047, "PERMISSION_DENIED"],
  [50048, "PERMISSION_DENIED"],
  [304032, "NOT_FOUND"],
  [306002, "NOT_FOUND"],
]);

interface QQParsedOpenApiError {
  code?: number;
  message?: string;
}

const EMPTY_MESSAGE_CONTENT = " ";

/**
 * Render Chat SDK postable message into QQ outbound text payload.
 *
 * QQ rejects empty content, so whitespace fallback is used when rendered text
 * is blank.
 */
export function buildOutboundContent(converter: QQFormatConverter, message: AdapterPostableMessage): string {
  const rendered = converter.renderPostable(message).trim();
  return rendered.length > 0 ? rendered : EMPTY_MESSAGE_CONTENT;
}

/**
 * Convert QQ HTTP/OpenAPI failures to Chat SDK standard errors.
 *
 * Priority:
 * 1) HTTP 429
 * 2) Known QQ `code/errcode` mapping
 * 3) HTTP status fallback
 */
export function toChatError(params: {
  endpoint: string;
  message: string;
  responseBody?: string;
  status?: number;
}): ChatError | RateLimitError {
  const parsedError = parseQQOpenApiError(params.responseBody);
  const detail = formatErrorDetail(params.responseBody, parsedError);
  const mappedCodeType = parsedError.code !== undefined ? QQ_ERROR_CODE_MAP.get(parsedError.code) : undefined;

  if (params.status === 429) {
    return new RateLimitError(`${params.message} at ${params.endpoint}${detail}`);
  }

  if (mappedCodeType) {
    switch (mappedCodeType) {
      case "RATE_LIMIT":
        return new RateLimitError(`${params.message} at ${params.endpoint}${detail}`);
      case "AUTH_FAILED":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "AUTH_FAILED");
      case "PERMISSION_DENIED":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "PERMISSION_DENIED");
      case "NOT_FOUND":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "NOT_FOUND");
      default:
        return assertNever(mappedCodeType);
    }
  }

  if (params.status === 401) {
    return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "AUTH_FAILED");
  }
  if (params.status === 403) {
    return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "PERMISSION_DENIED");
  }
  if (params.status === 404) {
    return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "NOT_FOUND");
  }
  return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "NETWORK_ERROR");
}

/** Parse cursor token to in-memory message index. */
export function parseCursor(cursor: string | undefined): number | null {
  if (!cursor) {
    return null;
  }
  const value = Number(cursor);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * Parse QQ timestamp (seconds/milliseconds/ISO string) to Date.
 *
 * @param fallbackToNow When true, invalid or empty input falls back to `new Date()`.
 */
export function parseQQTimestamp(value: string | undefined, fallbackToNow: true): Date;
export function parseQQTimestamp(value: string | undefined, fallbackToNow: false): Date | null;
export function parseQQTimestamp(value: string | undefined, fallbackToNow: boolean): Date | null {
  if (!value) {
    return fallbackToNow ? new Date() : null;
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber > 10_000_000_000 ? asNumber : asNumber * 1000);
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  return fallbackToNow ? new Date() : null;
}

/**
 * Derive a deterministic 32-byte seed from bot secret for webhook challenge signing.
 */
export function createBotSeed(secret: string): Buffer {
  const source = Buffer.from(secret, "utf8");
  if (source.length === 0) {
    throw new Error("QQ adapter secret cannot be empty.");
  }
  const seed = Buffer.alloc(32);
  for (let i = 0; i < seed.length; i += 1) {
    seed[i] = source[i % source.length];
  }
  return seed;
}

/** Runtime shape check for QQ webhook validation payload (`op=13`). */
export function isValidationPayload(data: unknown): data is QQWebhookValidationData {
  if (!data || typeof data !== "object") {
    return false;
  }
  const payload = data as QQWebhookValidationData;
  return typeof payload.event_ts === "string" && typeof payload.plain_token === "string";
}

/** Exhaustiveness assertion helper for discriminated unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

function parseQQOpenApiError(responseBody: string | undefined): QQParsedOpenApiError {
  if (!responseBody) {
    return {};
  }

  try {
    const parsed = JSON.parse(responseBody) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const root = parsed as Record<string, unknown>;
    const code = toIntegerCode(root.code ?? root.errcode);
    const message = toErrorMessage(root.message ?? root.msg);
    return { code, message };
  } catch {
    return {};
  }
}

function formatErrorDetail(responseBody: string | undefined, parsedError: QQParsedOpenApiError): string {
  if (parsedError.code !== undefined || parsedError.message) {
    const segments: string[] = [];
    if (parsedError.code !== undefined) {
      segments.push(`code=${parsedError.code}`);
    }
    if (parsedError.message) {
      segments.push(`message=${parsedError.message}`);
    }
    return `: ${segments.join(", ")}`;
  }

  if (!responseBody) {
    return "";
  }
  return `: ${responseBody}`;
}

function toIntegerCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
}

function toErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
