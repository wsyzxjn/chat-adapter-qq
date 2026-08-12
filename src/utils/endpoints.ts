import {
  BOT_API_BASE_URL,
  BOT_TOKEN_ENDPOINT,
  DEFAULT_API_BASE_URL,
  DEFAULT_TOKEN_ENDPOINT,
  SANDBOX_API_BASE_URL,
} from "../constants.js";
import type { QQAdapterBaseConfig, QQApiHost } from "../types.js";

export interface QQResolvedEndpoints {
  apiBaseUrl: string;
  apiHost: QQApiHost;
  fallbackApiBaseUrl?: string;
  fallbackTokenEndpoint?: string;
  tokenEndpoint: string;
}

function hostFamily(host: QQApiHost): { apiBaseUrl: string; tokenEndpoint: string } {
  if (host === "bot") {
    return {
      apiBaseUrl: BOT_API_BASE_URL,
      tokenEndpoint: BOT_TOKEN_ENDPOINT,
    };
  }
  return {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    tokenEndpoint: DEFAULT_TOKEN_ENDPOINT,
  };
}

/**
 * Resolve OpenAPI and token URLs.
 *
 * Defaults stay on the historical `sgroup` / `bots.qq.com` hosts so existing
 * installs keep working. `apiHost: "bot"` selects the newer wiki hosts.
 * When URLs are left at defaults, a one-shot network fallback to the other
 * family is available.
 */
export function resolveQQEndpoints(config: QQAdapterBaseConfig): QQResolvedEndpoints {
  const apiHost = config.apiHost ?? "sgroup";
  const family = hostFamily(apiHost);
  const alternate = hostFamily(apiHost === "bot" ? "sgroup" : "bot");
  const tokenEndpoint = config.tokenEndpoint ?? family.tokenEndpoint;
  const apiBaseUrl = config.apiBaseUrl ?? (config.sandbox ? SANDBOX_API_BASE_URL : family.apiBaseUrl);
  const allowFallback = config.hostFallback !== false
    && !config.tokenEndpoint
    && !config.apiBaseUrl
    && !config.sandbox;

  return {
    apiBaseUrl,
    apiHost,
    tokenEndpoint,
    ...(allowFallback
      ? {
          fallbackApiBaseUrl: alternate.apiBaseUrl,
          fallbackTokenEndpoint: alternate.tokenEndpoint,
        }
      : {}),
  };
}
