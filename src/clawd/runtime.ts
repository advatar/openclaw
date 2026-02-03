import { randomUUID } from "node:crypto";
import { waitForever } from "../cli/wait.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildAgentMainSessionKey, DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import { ensureClawdDirs, loadClawdConfig, type ClawdConfig, type ClawdPaths } from "./config.js";
import { createClawdCronService } from "./cron.js";
import { createClawdHeartbeat } from "./heartbeat.js";
import { ClawdSessionStore } from "./sessions.js";

const log = createSubsystemLogger("clawd/runtime");

export type ClawdRuntime = {
  config: ClawdConfig;
  paths: ClawdPaths;
  sessions: ClawdSessionStore;
  codex: CodexAppServerClient;
  mainSessionKey: string;
  ensureThread: (sessionKey: string) => Promise<string>;
  runTurn: (params: {
    sessionKey: string;
    text: string;
    model?: string | null;
    effort?: string | null;
    timeoutMs?: number;
  }) => Promise<{
    status: "completed" | "failed" | "interrupted";
    outputText?: string;
    error?: string;
  }>;
  sendMessage: (params: {
    channel: string;
    to: string;
    text: string;
    accountId?: string;
    sessionKey?: string;
  }) => Promise<{ ok: boolean; error?: string; result?: unknown }>;
  heartbeat: ReturnType<typeof createClawdHeartbeat>;
  cron: ReturnType<typeof createClawdCronService>;
  startSchedulers: () => void;
  stopSchedulers: () => void;
};

export async function createClawdRuntime(params?: {
  enableCron?: boolean;
  enableHeartbeat?: boolean;
}): Promise<ClawdRuntime> {
  const { config, paths } = await loadClawdConfig();
  await ensureClawdDirs(paths);
  const mainSessionKey = buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID });
  const sessions = new ClawdSessionStore(paths.sessionsPath);

  const codexArgsRaw = config.codex?.args ?? [];
  const hasAppServer = codexArgsRaw.some((arg) => arg === "app-server");
  const codexArgs = hasAppServer ? codexArgsRaw : [...codexArgsRaw, "app-server"];
  const codex = new CodexAppServerClient({
    command: config.codex?.command ?? "codex",
    args: codexArgs,
    cwd: config.codex?.cwd,
    autoApprove: config.codex?.autoApprove ?? false,
  });

  const threadOverrides = {
    model: config.codex?.model ?? null,
    modelProvider: config.codex?.modelProvider ?? null,
    cwd: config.codex?.cwd ?? paths.workspaceDir,
    approvalPolicy: config.codex?.approvalPolicy ?? "on-request",
    sandbox: config.codex?.sandbox ?? "workspace-write",
    config: config.codex?.config ?? null,
    baseInstructions: config.codex?.baseInstructions ?? null,
    developerInstructions: config.codex?.developerInstructions ?? null,
    personality: null,
  } as const;

  const ensureThread = async (sessionKey: string) => {
    const existing = await sessions.get(sessionKey);
    if (existing?.threadId) {
      try {
        await codex.threadResume({
          threadId: existing.threadId,
          ...threadOverrides,
        });
        return existing.threadId;
      } catch (err) {
        log.warn("clawd: failed to resume thread, starting new", { err: String(err) });
      }
    }
    const started = await codex.threadStart({ ...threadOverrides });
    await sessions.setThreadId(sessionKey, started.threadId);
    return started.threadId;
  };

  const runTurn = async (params: {
    sessionKey: string;
    text: string;
    model?: string | null;
    effort?: string | null;
    timeoutMs?: number;
  }) => {
    const threadId = await ensureThread(params.sessionKey);
    return await runTurnForThread({
      threadId,
      text: params.text,
      model: params.model ?? threadOverrides.model,
      effort: params.effort ?? null,
      timeoutMs: params.timeoutMs,
    });
  };

  const runTurnForThread = async (params: {
    threadId: string;
    text: string;
    model?: string | null;
    effort?: string | null;
    timeoutMs?: number;
  }) =>
    await codex.runTurn({
      threadId: params.threadId,
      text: params.text,
      model: params.model ?? threadOverrides.model,
      effort: params.effort ?? null,
      summary: null,
      approvalPolicy: threadOverrides.approvalPolicy,
      timeoutMs: params.timeoutMs,
    });

  const sendMessage = async (params: {
    channel: string;
    to: string;
    text: string;
    accountId?: string;
    sessionKey?: string;
  }) => {
    const sessionKey = params.sessionKey ?? mainSessionKey;
    const message = params.text.trim();
    if (!message) {
      return { ok: false, error: "message text required" };
    }
    try {
      const result = await callGateway({
        method: "send",
        params: {
          channel: params.channel,
          to: params.to,
          message,
          accountId: params.accountId,
          sessionKey,
          idempotencyKey: randomUUID(),
        },
        url: config.gateway?.url,
        token: config.gateway?.token,
        password: config.gateway?.password,
        tlsFingerprint: config.gateway?.tlsFingerprint,
      });
      await sessions.setLastRoute(sessionKey, {
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
      });
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  };

  const heartbeat = createClawdHeartbeat({
    config,
    paths,
    mainSessionKey,
    hasPendingTurns: () => codex.hasPendingTurns(),
    ensureThread,
    runTurn: async (opts) => await runTurn({ sessionKey: mainSessionKey, text: opts.text }),
    getLastRoute: async () => await sessions.getLastRoute(mainSessionKey),
    sendMessage: async (params) =>
      await sendMessage({
        channel: params.channel,
        to: params.to,
        text: params.text,
        accountId: params.accountId,
        sessionKey: params.sessionKey,
      }),
  });

  const cron = createClawdCronService({
    config,
    paths,
    ensureThread,
    runTurn: async (opts) => await runTurnForThread(opts),
    getLastRoute: async () => await sessions.getLastRoute(mainSessionKey),
    sendMessage: async (params) =>
      await sendMessage({
        channel: params.channel,
        to: params.to,
        text: params.text,
        accountId: params.accountId,
        sessionKey: params.sessionKey,
      }),
    runHeartbeatOnce: async (opts) => await heartbeat.runOnce(opts),
  });

  const startSchedulers = () => {
    if (params?.enableHeartbeat !== false && config.heartbeat?.enabled !== false) {
      heartbeat.start();
    }
    if (params?.enableCron !== false && config.cron?.enabled !== false) {
      void cron.cron.start();
    }
  };

  const stopSchedulers = () => {
    heartbeat.stop();
    cron.cron.stop();
  };

  return {
    config,
    paths,
    sessions,
    codex,
    mainSessionKey,
    ensureThread,
    runTurn,
    sendMessage,
    heartbeat,
    cron,
    startSchedulers,
    stopSchedulers,
  };
}

export async function runClawdDaemon() {
  const runtime = await createClawdRuntime({ enableCron: true, enableHeartbeat: true });
  runtime.startSchedulers();
  process.on("SIGINT", () => runtime.stopSchedulers());
  process.on("SIGTERM", () => runtime.stopSchedulers());
  await waitForever();
}
