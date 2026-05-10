import type { Logger } from "chat";
import {
  CALLBACK_DISPATCH_OPCODE,
  DEFAULT_GATEWAY_INTENTS,
  GATEWAY_HEARTBEAT_ACK_OPCODE,
  GATEWAY_HEARTBEAT_OPCODE,
  GATEWAY_HELLO_OPCODE,
  GATEWAY_IDENTIFY_OPCODE,
  GATEWAY_INVALID_SESSION_OPCODE,
  GATEWAY_RECONNECT_OPCODE,
  GATEWAY_RESUME_OPCODE,
} from "./constants.js";
import type {
  QQGatewayBotResponse,
  QQSocketModeMessageData,
  QQSocketModeOptions,
  QQSocketModeWebSocket,
  QQSocketModeWebSocketFactory,
  QQWebhookPayload,
} from "./types.js";

interface QQGatewayClientOptions {
  getGatewayInfo: () => Promise<QQGatewayBotResponse>;
  getToken: () => Promise<string>;
  logger: Logger;
  onDispatch: (payload: QQWebhookPayload<unknown>) => Promise<void>;
  options?: QQSocketModeOptions;
}

interface QQGatewayHelloData {
  heartbeat_interval?: number;
}

interface QQGatewayReadyData {
  session_id?: string;
}

export class QQGatewayClient {
  private readonly getGatewayInfo: () => Promise<QQGatewayBotResponse>;
  private readonly getToken: () => Promise<string>;
  private readonly logger: Logger;
  private readonly onDispatch: (payload: QQWebhookPayload<unknown>) => Promise<void>;
  private readonly options: QQSocketModeOptions;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: QQSocketModeWebSocket | null = null;
  private stopped = true;

  constructor(options: QQGatewayClientOptions) {
    this.getGatewayInfo = options.getGatewayInfo;
    this.getToken = options.getToken;
    this.logger = options.logger;
    this.onDispatch = options.onDispatch;
    this.options = {
      reconnect: true,
      reconnectDelayMs: 1000,
      resume: true,
      ...options.options,
    };
  }

  get isActive(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      this.logger.debug("QQ gateway already active");
      return;
    }

    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "QQ gateway stopped");
  }

  private async connect(): Promise<void> {
    const url = this.options.url ?? (await this.getGatewayInfo()).url;
    const webSocketFactory = this.resolveWebSocketFactory();
    this.logger.info("QQ gateway connecting", { url });
    const socket = webSocketFactory(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      socket.addEventListener("open", () => {
        this.logger.info("QQ gateway connected");
        settle(resolve);
      });
      socket.addEventListener("message", (event) => {
        this.handleSocketMessage(event).catch((error) => {
          this.logger.error("QQ gateway message handling failed", error);
        });
      });
      socket.addEventListener("error", (event) => {
        this.logger.warn("QQ gateway socket error", event);
        settle(() => reject(new Error("QQ gateway socket error.")));
      });
      socket.addEventListener("close", () => {
        this.logger.info("QQ gateway closed");
        this.clearHeartbeat();
        if (this.socket === socket) {
          this.socket = null;
        }
        if (!this.stopped && this.options.reconnect !== false) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private async handleSocketMessage(event: MessageEvent<QQSocketModeMessageData>): Promise<void> {
    const data = event.data;
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : "";
    if (!text) {
      this.logger.warn("QQ gateway ignored non-text message");
      return;
    }

    let payload: QQWebhookPayload<unknown>;
    try {
      payload = JSON.parse(text) as QQWebhookPayload<unknown>;
    } catch (error) {
      this.logger.warn("QQ gateway received invalid JSON", error);
      return;
    }

    await this.handlePayload(payload);
  }

  async handlePayload(payload: QQWebhookPayload<unknown>): Promise<void> {
    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case GATEWAY_HELLO_OPCODE:
        this.handleHello(payload.d);
        await this.identifyOrResume();
        return;
      case GATEWAY_HEARTBEAT_OPCODE:
        this.sendHeartbeat();
        return;
      case GATEWAY_HEARTBEAT_ACK_OPCODE:
        this.logger.debug("QQ gateway heartbeat acknowledged", { seq: this.sequence });
        return;
      case GATEWAY_RECONNECT_OPCODE:
        this.logger.info("QQ gateway requested reconnect");
        this.reconnect();
        return;
      case GATEWAY_INVALID_SESSION_OPCODE:
        this.logger.warn("QQ gateway session invalidated");
        this.sessionId = null;
        this.sequence = null;
        this.reconnect();
        return;
      case CALLBACK_DISPATCH_OPCODE:
        this.handleReady(payload);
        await this.onDispatch(payload);
        return;
      default:
        this.logger.debug("QQ gateway ignored opcode", { op: payload.op });
    }
  }

  private handleHello(data: unknown): void {
    const hello = data as QQGatewayHelloData | undefined;
    const interval = Number(hello?.heartbeat_interval);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.logger.warn("QQ gateway hello missing heartbeat interval", data);
      return;
    }

    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
    this.sendHeartbeat();
  }

  private handleReady(payload: QQWebhookPayload<unknown>): void {
    if (payload.t !== "READY") {
      return;
    }

    const ready = payload.d as QQGatewayReadyData | undefined;
    if (ready?.session_id) {
      this.sessionId = ready.session_id;
      this.logger.info("QQ gateway session ready", {
        sessionId: this.sessionId,
        seq: this.sequence,
      });
    }
  }

  private async identifyOrResume(): Promise<void> {
    const token = `QQBot ${await this.getToken()}`;
    if (this.options.resume !== false && this.sessionId && this.sequence !== null) {
      this.sendPayload({
        d: {
          seq: this.sequence,
          session_id: this.sessionId,
          token,
        },
        op: GATEWAY_RESUME_OPCODE,
      });
      return;
    }

    this.sendPayload({
      d: {
        intents: this.options.intents ?? DEFAULT_GATEWAY_INTENTS,
        properties: this.options.properties ?? {
          "$browser": "@amatsuka/chat-adapter-qq",
          "$device": "@amatsuka/chat-adapter-qq",
          "$os": process.platform,
        },
        shard: this.options.shard ?? [0, 1],
        token,
      },
      op: GATEWAY_IDENTIFY_OPCODE,
    });
  }

  private reconnect(): void {
    this.clearHeartbeat();
    this.socket?.close(4000, "QQ gateway reconnect");
    if (!this.stopped && this.options.reconnect !== false) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.options.reconnectDelayMs ?? 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.connect().catch((error) => {
        this.logger.warn("QQ gateway reconnect failed", error);
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private sendHeartbeat(): void {
    this.sendPayload({
      d: this.sequence,
      op: GATEWAY_HEARTBEAT_OPCODE,
    });
  }

  private sendPayload(payload: { d?: unknown; op: number }): void {
    if (!this.socket) {
      this.logger.warn("QQ gateway cannot send without an active socket", { op: payload.op });
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resolveWebSocketFactory(): QQSocketModeWebSocketFactory {
    if (this.options.webSocketFactory) {
      return this.options.webSocketFactory;
    }
    if (typeof WebSocket === "undefined") {
      throw new Error("QQ gateway requires a WebSocket implementation.");
    }
    return (url) => new WebSocket(url);
  }
}
