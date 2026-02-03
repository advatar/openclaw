import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("clawd/codex");

type JsonRpcId = number | string;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type CodexTurnResult = {
  status: "completed" | "failed" | "interrupted";
  outputText?: string;
  error?: string;
};

export type CodexAppServerOptions = {
  command: string;
  args: string[];
  cwd?: string;
  autoApprove: boolean;
};

type TurnTracker = {
  threadId: string;
  turnId: string;
  lastAgentText: string;
  lastNonEmptyText: string;
  itemTexts: Map<string, string>;
  resolve: (result: CodexTurnResult) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
};

function isRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message && !("result" in message) && !("error" in message);
}

function isRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message);
}

function isRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !("id" in message) && "method" in message;
}

function normalizeId(id: JsonRpcId): string {
  return typeof id === "number" ? String(id) : id;
}

function toError(response: JsonRpcResponse): Error {
  const message = response.error?.message ?? "Unknown JSON-RPC error";
  return new Error(message);
}

export class CodexAppServerClient {
  private child: ChildProcess | null = null;
  private reader: ReadLineInterface | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private turns = new Map<string, TurnTracker>();
  private started = false;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly opts: CodexAppServerOptions) {}

  hasPendingTurns(): boolean {
    return this.turns.size > 0;
  }

  async start() {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async stop() {
    this.started = false;
    this.startPromise = null;
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill("SIGTERM");
      await delay(250);
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async threadStart(params: {
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    config?: Record<string, unknown> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: unknown | null;
  }): Promise<{ threadId: string }> {
    await this.start();
    const res = await this.sendRequest("thread/start", {
      model: params.model ?? null,
      modelProvider: params.modelProvider ?? null,
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? null,
      sandbox: params.sandbox ?? null,
      config: params.config ?? null,
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.developerInstructions ?? null,
      personality: params.personality ?? null,
      ephemeral: null,
      experimentalRawEvents: false,
    });
    const threadId = (res as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server thread/start missing thread id");
    }
    return { threadId };
  }

  async threadResume(params: {
    threadId: string;
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
    config?: Record<string, unknown> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: unknown | null;
  }): Promise<{ threadId: string }> {
    await this.start();
    const res = await this.sendRequest("thread/resume", {
      threadId: params.threadId,
      history: null,
      path: null,
      model: params.model ?? null,
      modelProvider: params.modelProvider ?? null,
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? null,
      sandbox: params.sandbox ?? null,
      config: params.config ?? null,
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.developerInstructions ?? null,
      personality: params.personality ?? null,
    });
    const threadId = (res as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (!threadId) {
      throw new Error("codex app-server thread/resume missing thread id");
    }
    return { threadId };
  }

  async runTurn(params: {
    threadId: string;
    text: string;
    model?: string | null;
    effort?: string | null;
    summary?: string | null;
    approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never" | null;
    timeoutMs?: number;
  }): Promise<CodexTurnResult> {
    await this.start();
    const response = await this.sendRequest("turn/start", {
      threadId: params.threadId,
      input: [
        {
          type: "text",
          text: params.text,
          text_elements: [],
        },
      ],
      cwd: null,
      approvalPolicy: params.approvalPolicy ?? null,
      sandboxPolicy: null,
      model: params.model ?? null,
      effort: params.effort ?? null,
      summary: params.summary ?? null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });
    const turnId = (response as { turn?: { id?: string } } | undefined)?.turn?.id;
    if (!turnId) {
      throw new Error("codex app-server turn/start missing turn id");
    }
    return await this.trackTurn({
      threadId: params.threadId,
      turnId,
      timeoutMs: params.timeoutMs,
    });
  }

  private async startInternal() {
    const { command, args, cwd } = this.opts;
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    this.child = child;
    if (!child.stdout) {
      throw new Error("codex app-server stdout unavailable");
    }
    const reader = createInterface({ input: child.stdout });
    this.reader = reader;
    reader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let parsed: JsonRpcMessage | null = null;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      this.handleMessage(parsed);
    });
    child.on("exit", (code) => {
      log.warn("codex app-server exited", { code });
    });
    const initialize = await this.sendRequest("initialize", {
      client_info: {
        name: "clawd",
        title: "clawdex",
        version: "0.1.0",
      },
      capabilities: {
        experimental_api: true,
      },
    });
    if (!initialize) {
      throw new Error("codex app-server initialize failed");
    }
    await this.sendNotification("initialized", undefined);
    this.started = true;
  }

  private handleMessage(message: JsonRpcMessage) {
    if (isRpcResponse(message)) {
      const key = normalizeId(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      this.pending.delete(key);
      if (message.error) {
        pending.reject(toError(message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isRpcRequest(message)) {
      void this.handleServerRequest(message);
      return;
    }
    if (isRpcNotification(message)) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params?: unknown) {
    if (method === "item/agentMessage/delta") {
      const payload = params as {
        threadId?: string;
        turnId?: string;
        itemId?: string;
        delta?: string;
      };
      if (!payload?.turnId || !payload.itemId || typeof payload.delta !== "string") {
        return;
      }
      const tracker = this.turns.get(payload.turnId);
      if (!tracker) {
        return;
      }
      const existing = tracker.itemTexts.get(payload.itemId) ?? "";
      const next = `${existing}${payload.delta}`;
      tracker.itemTexts.set(payload.itemId, next);
      tracker.lastAgentText = next;
      const trimmed = next.trim();
      if (trimmed) {
        tracker.lastNonEmptyText = trimmed;
      }
      return;
    }
    if (method === "item/completed") {
      const payload = params as {
        threadId?: string;
        turnId?: string;
        item?: { type?: string; id?: string; text?: string };
      };
      if (!payload?.turnId || !payload.item || payload.item.type !== "agentMessage") {
        return;
      }
      const tracker = this.turns.get(payload.turnId);
      if (!tracker) {
        return;
      }
      const text = typeof payload.item.text === "string" ? payload.item.text : "";
      if (payload.item.id) {
        tracker.itemTexts.set(payload.item.id, text);
      }
      tracker.lastAgentText = text;
      const trimmed = text.trim();
      if (trimmed) {
        tracker.lastNonEmptyText = trimmed;
      }
      return;
    }
    if (method === "turn/completed") {
      const payload = params as {
        threadId?: string;
        turn?: { id?: string; status?: string; error?: { message?: string } | null };
      };
      const turnId = payload?.turn?.id;
      if (!turnId) {
        return;
      }
      const tracker = this.turns.get(turnId);
      if (!tracker) {
        return;
      }
      this.turns.delete(turnId);
      if (tracker.timeout) {
        clearTimeout(tracker.timeout);
      }
      const status = payload.turn?.status;
      if (status === "completed") {
        tracker.resolve({ status: "completed", outputText: tracker.lastNonEmptyText });
        return;
      }
      if (status === "interrupted") {
        tracker.resolve({ status: "interrupted", outputText: tracker.lastNonEmptyText });
        return;
      }
      const errorMessage = payload.turn?.error?.message ?? "codex turn failed";
      tracker.resolve({
        status: "failed",
        error: errorMessage,
        outputText: tracker.lastNonEmptyText,
      });
      return;
    }
  }

  private async handleServerRequest(request: JsonRpcRequest) {
    const method = request.method;
    if (method === "item/commandExecution/requestApproval") {
      const decision = this.opts.autoApprove ? "accept" : "decline";
      return await this.sendResponse(request.id, { decision });
    }
    if (method === "item/fileChange/requestApproval") {
      const decision = this.opts.autoApprove ? "accept" : "decline";
      return await this.sendResponse(request.id, { decision });
    }
    if (method === "item/tool/requestUserInput") {
      return await this.sendResponse(request.id, { answers: {} });
    }
    if (method === "item/tool/call") {
      return await this.sendResponse(request.id, {
        output: "clawd does not support dynamic tool calls",
        success: false,
      });
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      return await this.sendError(request.id, {
        code: -32601,
        message: "auth token refresh unsupported",
      });
    }
    return await this.sendError(request.id, {
      code: -32601,
      message: `unsupported request: ${method}`,
    });
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return await new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.writeMessage(payload);
    });
  }

  private async sendNotification(method: string, params?: unknown) {
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.writeMessage(payload);
  }

  private async sendResponse(id: JsonRpcId, result: unknown) {
    const payload: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.writeMessage(payload);
  }

  private async sendError(id: JsonRpcId, error: { code: number; message: string; data?: unknown }) {
    const payload: JsonRpcResponse = { jsonrpc: "2.0", id, error };
    this.writeMessage(payload);
  }

  private writeMessage(message: JsonRpcMessage) {
    const child = this.child;
    if (!child || !child.stdin) {
      throw new Error("codex app-server not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async trackTurn(params: {
    threadId: string;
    turnId: string;
    timeoutMs?: number;
  }): Promise<CodexTurnResult> {
    return await new Promise((resolve, reject) => {
      const tracker: TurnTracker = {
        threadId: params.threadId,
        turnId: params.turnId,
        lastAgentText: "",
        lastNonEmptyText: "",
        itemTexts: new Map<string, string>(),
        resolve,
        reject,
      };
      if (params.timeoutMs && params.timeoutMs > 0) {
        tracker.timeout = setTimeout(() => {
          this.turns.delete(params.turnId);
          reject(new Error("codex turn timeout"));
        }, params.timeoutMs);
      }
      this.turns.set(params.turnId, tracker);
    });
  }
}
