import { ChatError, RateLimitError } from "chat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getQQErrorCode, toChatError } from "../src/utils/errors.ts";

describe("QQ OpenAPI error mapping", () => {
  it("maps 11282 ErrorCheckAdminNotPass to PERMISSION_DENIED", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/groups/g/restrict_chat_setting",
      message: "QQ API request failed (403)",
      responseBody: JSON.stringify({ code: 11282, message: "ErrorCheckAdminNotPass" }),
      status: 403,
    });
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.match(error.message, /code=11282/);
  });

  it("maps err_code-only 11282 without HTTP 403 to PERMISSION_DENIED", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/groups/g/restrict_chat_setting",
      message: "QQ API request failed (400)",
      responseBody: JSON.stringify({ err_code: 11282, message: "ErrorCheckAdminNotPass" }),
      status: 400,
    });
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.match(error.message, /code=11282/);
  });

  it("maps 11298 IP whitelist denials to PERMISSION_DENIED", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/users/u/messages",
      message: "QQ API request failed (403)",
      responseBody: JSON.stringify({ code: 11298, message: "ip not in whitelist" }),
      status: 403,
    });
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.match(error.message, /code=11298/);
  });

  it("maps 11274 OAuth scope failures to PERMISSION_DENIED", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/users/u/messages",
      message: "QQ API request failed (403)",
      responseBody: JSON.stringify({ err_code: 11274, message: "ErrorUserAuthNotPass" }),
      status: 403,
    });
    assert.equal(error.code, "PERMISSION_DENIED");
  });

  it("does not map retryable 11281 admin-check system failures to PERMISSION_DENIED", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/groups/g/restrict_chat_setting",
      message: "QQ API request failed (500)",
      responseBody: JSON.stringify({ err_code: 11281, message: "ErrorCheckAdminFailed" }),
      status: 500,
    });
    assert.ok(error instanceof ChatError);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.match(error.message, /code=11281/);
  });

  it("prefers code over errcode over err_code", () => {
    assert.equal(getQQErrorCode({ code: 11282, errcode: 1, err_code: 2 }), 11282);
    assert.equal(getQQErrorCode({ errcode: 11282, err_code: 2 }), 11282);
    assert.equal(getQQErrorCode({ err_code: 11282 }), 11282);
    assert.equal(getQQErrorCode({ code: 0, err_code: 11282 }), 0);
  });

  it("still maps HTTP 429 before QQ codes", () => {
    const error = toChatError({
      endpoint: "https://api.example.test/v2/users/u/messages",
      message: "QQ API request failed (429)",
      responseBody: JSON.stringify({ err_code: 11282 }),
      retryAfterMs: 1500,
      status: 429,
    });
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfterMs, 1500);
  });
});
