import { ChatError, RateLimitError } from "chat";
import { assertNever } from "./assert.js";

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
    const error: QQParsedOpenApiError = {};
    if (code !== undefined) {
      error.code = code;
    }
    if (message !== undefined) {
      error.message = message;
    }
    return error;
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
