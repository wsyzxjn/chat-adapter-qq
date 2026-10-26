import { ChatError, RateLimitError } from "chat";
import { assertNever } from "./assert.js";

type QQMappedErrorType =
  | "AUTH_FAILED"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "RATE_LIMIT";

const QQ_ERROR_CODE_MAP = new Map<number, QQMappedErrorType>([
  [40007, "INVALID_REQUEST"],
  [50002, "RATE_LIMIT"],
  [100001, "RATE_LIMIT"],
  [10000, "INVALID_REQUEST"],
  [10001, "INVALID_REQUEST"],
  [10002, "INVALID_REQUEST"],
  [10003, "NOT_FOUND"],
  [10044, "AUTH_FAILED"],
  [11004, "NETWORK_ERROR"],
  [100007, "AUTH_FAILED"],
  [100016, "AUTH_FAILED"],
  [10004, "NOT_FOUND"],
  [22006, "INVALID_REQUEST"],
  [850018, "PERMISSION_DENIED"],
  [850019, "INVALID_REQUEST"],
  [850026, "NETWORK_ERROR"],
  [850027, "NETWORK_ERROR"],
  [850031, "INVALID_REQUEST"],
  [304103, "NOT_FOUND"],
  [304004, "PERMISSION_DENIED"],
  [304014, "PERMISSION_DENIED"],
  [304036, "PERMISSION_DENIED"],
  [304037, "PERMISSION_DENIED"],
  [304061, "INVALID_REQUEST"],
  [304064, "PERMISSION_DENIED"],
  [304080, "INVALID_REQUEST"],
  [305007, "INVALID_REQUEST"],
  [340069, "INVALID_REQUEST"],
  [340067, "NETWORK_ERROR"],
  [40034005, "NOT_FOUND"],
  [40034006, "INVALID_REQUEST"],
  [40034008, "INVALID_REQUEST"],
  [40034009, "INVALID_REQUEST"],
  [40034010, "INVALID_REQUEST"],
  [40034011, "INVALID_REQUEST"],
  [40034024, "PERMISSION_DENIED"],
  [40034025, "INVALID_REQUEST"],
  [40034026, "NOT_FOUND"],
  [40034027, "INVALID_REQUEST"],
  [40034029, "INVALID_REQUEST"],
  [40034100, "RATE_LIMIT"],
  [40034101, "PERMISSION_DENIED"],
  [40034105, "PERMISSION_DENIED"],
  [40034106, "INVALID_REQUEST"],
  [40034108, "INVALID_REQUEST"],
  [40034109, "INVALID_REQUEST"],
  [40034122, "RATE_LIMIT"],
  [40034123, "INVALID_REQUEST"],
  [40034124, "INVALID_REQUEST"],
  [40034127, "PERMISSION_DENIED"],
  [40034128, "RATE_LIMIT"],
  [40054002, "PERMISSION_DENIED"],
  [40054003, "PERMISSION_DENIED"],
  [40054004, "PERMISSION_DENIED"],
  [40054005, "INVALID_REQUEST"],
  [40054006, "NETWORK_ERROR"],
  [40054007, "INVALID_REQUEST"],
  [40054010, "INVALID_REQUEST"],
  [40054013, "PERMISSION_DENIED"],
  [40054018, "INVALID_REQUEST"],
  [40061001, "INVALID_REQUEST"],
  [40061002, "INVALID_REQUEST"],
  [40062003, "PERMISSION_DENIED"],
  [40064004, "INVALID_REQUEST"],
  [40093002, "RATE_LIMIT"],
  [40093001, "NETWORK_ERROR"],
  [40030001, "INVALID_REQUEST"],
  [40030006, "NOT_FOUND"],
  [40030008, "INVALID_REQUEST"],
  [40030009, "RATE_LIMIT"],
  [40030011, "INVALID_REQUEST"],
  [40030012, "INVALID_REQUEST"],
  [40030013, "INVALID_REQUEST"],
  [40030014, "INVALID_REQUEST"],
  [40030015, "INVALID_REQUEST"],
  [40030016, "INVALID_REQUEST"],
  [40030017, "INVALID_REQUEST"],
  [40030018, "INVALID_REQUEST"],
  [40030020, "INVALID_REQUEST"],
  [40030021, "INVALID_REQUEST"],
  [40035001, "INVALID_REQUEST"],
  [40035002, "INVALID_REQUEST"],
  [40035003, "INVALID_REQUEST"],
  [40035006, "NETWORK_ERROR"],
  [40035007, "RATE_LIMIT"],
  [40035008, "NOT_FOUND"],
  [40035009, "NOT_FOUND"],
  [40035010, "PERMISSION_DENIED"],
  [20028, "RATE_LIMIT"],
  [22009, "RATE_LIMIT"],
  [304019, "RATE_LIMIT"],
  [304035, "RATE_LIMIT"],
  [304045, "RATE_LIMIT"],
  [304047, "RATE_LIMIT"],
  [304049, "RATE_LIMIT"],
  [304050, "RATE_LIMIT"],
  [610013, "RATE_LIMIT"],
  [620006, "RATE_LIMIT"],
  [1100100, "RATE_LIMIT"],
  [1100308, "RATE_LIMIT"],
  [11241, "AUTH_FAILED"],
  [11242, "AUTH_FAILED"],
  [11243, "AUTH_FAILED"],
  [11251, "AUTH_FAILED"],
  [11252, "NETWORK_ERROR"],
  [11253, "PERMISSION_DENIED"],
  [11254, "PERMISSION_DENIED"],
  [11261, "AUTH_FAILED"],
  [11263, "NETWORK_ERROR"],
  [11264, "PERMISSION_DENIED"],
  [11265, "PERMISSION_DENIED"],
  [11273, "AUTH_FAILED"],
  [11274, "PERMISSION_DENIED"],
  [11275, "AUTH_FAILED"],
  [11282, "PERMISSION_DENIED"],
  [304026, "INVALID_REQUEST"],
  [304027, "NOT_FOUND"],
  [304028, "INVALID_REQUEST"],
  [304031, "PERMISSION_DENIED"],
  [304032, "NOT_FOUND"],
  [304046, "PERMISSION_DENIED"],
  [304048, "PERMISSION_DENIED"],
  [50045, "INVALID_REQUEST"],
  [50046, "INVALID_REQUEST"],
  [50047, "INVALID_REQUEST"],
  [50048, "INVALID_REQUEST"],
  [50056, "INVALID_REQUEST"],
  [50055001, "NETWORK_ERROR"],
  [50055002, "NETWORK_ERROR"],
  [50055006, "NETWORK_ERROR"],
  [306002, "NOT_FOUND"],
  [306004, "PERMISSION_DENIED"],
]);

interface QQParsedOpenApiError {
  code?: number;
  message?: string;
  traceId?: string;
}

/**
 * Convert QQ HTTP/OpenAPI failures (err_code / code / errcode) to Chat SDK errors.
 *
 * Priority:
 * 1) HTTP 429
 * 2) Known QQ `code/errcode` mapping
 * 3) HTTP status fallback
 */
export function toChatError(params: {
  endpoint: string;
  message: string;
  retryAfterMs?: number;
  responseBody?: string;
  status?: number;
}): ChatError | RateLimitError {
  const parsedError = parseQQOpenApiError(params.responseBody);
  const detail = formatErrorDetail(params.responseBody, parsedError);
  const mappedCodeType = parsedError.code !== undefined ? QQ_ERROR_CODE_MAP.get(parsedError.code) : undefined;

  if (params.status === 429) {
    return new RateLimitError(`${params.message} at ${params.endpoint}${detail}`, params.retryAfterMs);
  }

  if (mappedCodeType) {
    switch (mappedCodeType) {
      case "RATE_LIMIT":
        return new RateLimitError(`${params.message} at ${params.endpoint}${detail}`, params.retryAfterMs);
      case "AUTH_FAILED":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "AUTH_FAILED");
      case "INVALID_REQUEST":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "INVALID_REQUEST");
      case "NETWORK_ERROR":
        return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "NETWORK_ERROR");
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
  if (params.status === 400 || params.status === 405 || params.status === 409 || params.status === 422) {
    return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "INVALID_REQUEST");
  }
  return new ChatError(`${params.message} at ${params.endpoint}${detail}`, "NETWORK_ERROR");
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
    const code = getQQBusinessCode(root);
    const message = toErrorMessage(root.message ?? root.msg);
    const error: QQParsedOpenApiError = {};
    if (code !== undefined) {
      error.code = code;
    }
    if (message !== undefined) {
      error.message = message;
    }
    if (typeof root.trace_id === "string") {
      error.traceId = root.trace_id;
    }
    return error;
  } catch {
    return {};
  }
}

function formatErrorDetail(responseBody: string | undefined, parsedError: QQParsedOpenApiError): string {
  if (parsedError.code !== undefined || parsedError.message || parsedError.traceId) {
    const segments: string[] = [];
    if (parsedError.code !== undefined) {
      segments.push(`code=${parsedError.code}`);
    }
    if (parsedError.message) {
      segments.push(`message=${parsedError.message}`);
    }
    if (parsedError.traceId) {
      segments.push(`trace_id=${parsedError.traceId}`);
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

export function getQQBusinessCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return toIntegerCode(record.err_code ?? record.code ?? record.errcode);
}

function toErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
