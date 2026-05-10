import { createServer } from "node:http";
import { testBot } from "./bot.ts";

const DEFAULT_PORT = 3000;
const host = process.env.HOST ?? process.env.QQ_TEST_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? process.env.QQ_TEST_PORT ?? DEFAULT_PORT);
const debugWebhook = process.env.QQ_DEBUG_WEBHOOK === "true";

function parseWebhookMeta(rawBody) {
  try {
    const payload = JSON.parse(rawBody);
    return {
      op: payload?.op,
      s: payload?.s,
      t: payload?.t,
      bodyLength: rawBody.length,
      hasPlainToken: typeof payload?.d?.plain_token === "string",
      hasEventTs: typeof payload?.d?.event_ts === "string",
    };
  } catch {
    return {
      bodyLength: rawBody.length,
      invalidJson: true,
    };
  }
}

function logWebhookRequest(req, rawBody) {
  if (!debugWebhook) {
    return;
  }
  console.log("[qq-webhook] incoming", {
    method: req.method,
    url: req.url,
    host: req.headers.host,
    forwardedHost: req.headers["x-forwarded-host"],
    forwardedProto: req.headers["x-forwarded-proto"],
    appId: req.headers["x-bot-appid"],
    hasSignature: typeof req.headers["x-signature-ed25519"] === "string",
    hasSignatureTimestamp: typeof req.headers["x-signature-timestamp"] === "string",
    contentType: req.headers["content-type"],
    ...parseWebhookMeta(rawBody),
  });
}

function logRequest(req) {
  if (!debugWebhook) {
    return;
  }
  console.log("[http] incoming", {
    method: req.method,
    url: req.url,
    host: req.headers.host,
    forwardedHost: req.headers["x-forwarded-host"],
    forwardedProto: req.headers["x-forwarded-proto"],
    userAgent: req.headers["user-agent"],
  });
}

function toHeadersObject(req) {
  const output = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.join(", ");
    }
  }
  return output;
}

async function readRawBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return "";
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function toWebRequest(req) {
  const rawBody = await readRawBody(req);
  logWebhookRequest(req, rawBody);
  const protocol = req.headers["x-forwarded-proto"] ?? "http";
  const requestHost = req.headers["x-forwarded-host"] ?? req.headers.host ?? `${host}:${port}`;
  const url = `${protocol}://${requestHost}${req.url ?? "/"}`;

  return new Request(url, {
    body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
    headers: toHeadersObject(req),
    method: req.method ?? "POST",
  });
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(await response.text());
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  try {
    logRequest(req);
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`).pathname;

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "qq-test-bot",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (pathname === "/webhooks/qq") {
      const request = await toWebRequest(req);
      const startedAt = performance.now();
      const response = await testBot.webhooks.qq(request);
      if (debugWebhook) {
        console.log("[qq-webhook] response", {
          elapsedMs: Math.round(performance.now() - startedAt),
          status: response.status,
          contentType: response.headers.get("content-type"),
        });
      }
      await sendWebResponse(res, response);
      return;
    }

    sendJson(res, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Use GET /health or POST /webhooks/qq.",
      },
    });
  } catch (error) {
    console.error("QQ test server failed to handle request", error);
    sendJson(res, 500, {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal test server error.",
      },
    });
  }
});

server.on("error", (error) => {
  console.error("[http] server error", error);
});

await testBot.initialize();

server.listen(port, host, () => {
  console.log("[http] QQ test bot started", {
    health: `http://${host}:${port}/health`,
    host,
    pid: process.pid,
    port,
    webhook: `http://${host}:${port}/webhooks/qq`,
    debugWebhook,
  });
});
