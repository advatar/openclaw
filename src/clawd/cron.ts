import type { Logger } from "../cron/service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { CodexTurnResult } from "./codex/app-server.js";
import type { ClawdConfig, ClawdPaths } from "./config.js";
import type { ClawdRoute } from "./sessions.js";
import { pickSummaryFromOutput } from "../cron/isolated-agent/helpers.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../cron/normalize.js";
import { appendCronRunLog, readCronRunLogEntries, resolveCronRunLogPath } from "../cron/run-log.js";
import { CronService } from "../cron/service.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
} from "../routing/session-key.js";

const log = createSubsystemLogger("clawd/cron");

export type ClawdCronDeps = {
  config: ClawdConfig;
  paths: ClawdPaths;
  ensureThread: (sessionKey: string) => Promise<string>;
  runTurn: (params: {
    threadId: string;
    text: string;
    model?: string | null;
    effort?: string | null;
    timeoutMs?: number;
  }) => Promise<CodexTurnResult>;
  getLastRoute: () => Promise<ClawdRoute | undefined>;
  sendMessage: (params: {
    channel: string;
    to: string;
    text: string;
    accountId?: string;
    sessionKey: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  runHeartbeatOnce: (opts?: { reason?: string }) => Promise<HeartbeatRunResult>;
};

function formatCronPrompt(job: CronJob, message: string): string {
  const base = `[cron:${job.id} ${job.name}] ${message}`.trim();
  const timeLine = `Current time: ${new Date().toISOString()}`;
  return `${base}\n${timeLine}`.trim();
}

function resolveSessionKey(agentId: string, jobId: string) {
  return buildAgentMainSessionKey({ agentId, mainKey: `cron:${jobId}` });
}

async function resolveDeliveryTarget(
  payload: Extract<CronJob["payload"], { kind: "agentTurn" }>,
  getLastRoute: () => Promise<ClawdRoute | undefined>,
): Promise<{ channel?: string; to?: string; accountId?: string }> {
  const rawChannel = typeof payload.channel === "string" ? payload.channel.trim() : "";
  const channel = rawChannel && rawChannel !== "last" ? rawChannel : undefined;
  const to = typeof payload.to === "string" && payload.to.trim() ? payload.to.trim() : undefined;
  if (channel && to) {
    return { channel, to };
  }
  const last = await getLastRoute();
  if (!last) {
    return { channel, to };
  }
  if (!channel || rawChannel === "last") {
    return {
      channel: last.channel,
      to: to ?? last.to,
      accountId: last.accountId,
    };
  }
  if (!to && channel === last.channel) {
    return {
      channel: last.channel,
      to: last.to,
      accountId: last.accountId,
    };
  }
  return { channel, to };
}

async function runIsolatedJob(deps: ClawdCronDeps, job: CronJob, message: string) {
  if (job.payload.kind !== "agentTurn") {
    return { status: "skipped", summary: "isolated job requires payload.kind=agentTurn" } as const;
  }
  const agentId = normalizeAgentId(job.agentId ?? DEFAULT_AGENT_ID);
  const sessionKey = resolveSessionKey(agentId, job.id);
  const prompt = formatCronPrompt(job, message);
  const payload = job.payload;
  const timeoutMs =
    typeof payload.timeoutSeconds === "number" && Number.isFinite(payload.timeoutSeconds)
      ? Math.max(0, Math.floor(payload.timeoutSeconds * 1000))
      : undefined;
  const effort = typeof payload.thinking === "string" ? payload.thinking : undefined;
  const model = typeof payload.model === "string" ? payload.model : undefined;

  const threadId = await deps.ensureThread(sessionKey);
  const result = await deps.runTurn({ threadId, text: prompt, model, effort, timeoutMs });

  if (result.status === "failed") {
    return {
      status: "error",
      error: result.error ?? "codex turn failed",
      summary: pickSummaryFromOutput(result.outputText),
      outputText: result.outputText,
    } as const;
  }

  if (result.status === "interrupted") {
    return {
      status: "skipped",
      summary: pickSummaryFromOutput(result.outputText),
      outputText: result.outputText,
    } as const;
  }

  const outputText = result.outputText ?? "";
  const summary = pickSummaryFromOutput(outputText);
  const deliverFlag = payload.deliver;
  const deliverRequested =
    deliverFlag === true || (deliverFlag === undefined && Boolean(payload.to));
  if (!deliverRequested) {
    return { status: "ok", summary, outputText } as const;
  }

  const target = await resolveDeliveryTarget(payload, deps.getLastRoute);
  if (!target.channel || !target.to) {
    if (payload.bestEffortDeliver) {
      return {
        status: "skipped",
        summary: summary ?? "no delivery target",
        outputText,
      } as const;
    }
    return { status: "error", error: "no delivery target", summary, outputText } as const;
  }

  const cleanText = outputText.trim();
  if (!cleanText) {
    return { status: "skipped", summary: summary ?? "empty output", outputText } as const;
  }

  const delivered = await deps.sendMessage({
    channel: target.channel,
    to: target.to,
    text: cleanText,
    accountId: target.accountId,
    sessionKey: buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID }),
  });
  if (!delivered.ok) {
    if (payload.bestEffortDeliver) {
      return {
        status: "skipped",
        summary: summary ?? delivered.error,
        outputText,
      } as const;
    }
    return {
      status: "error",
      error: delivered.error ?? "delivery failed",
      summary,
      outputText,
    } as const;
  }

  return { status: "ok", summary, outputText } as const;
}

export function createClawdCronService(deps: ClawdCronDeps) {
  const cronEnabled = deps.config.cron?.enabled !== false;
  const storePath = deps.paths.cronStorePath;
  const cronLog: Logger = {
    debug: (obj, msg) => log.debug(msg ?? "cron", { obj }),
    info: (obj, msg) => log.info(msg ?? "cron", { obj }),
    warn: (obj, msg) => log.warn(msg ?? "cron", { obj }),
    error: (obj, msg) => log.error(msg ?? "cron", { obj }),
  };
  const cron = new CronService({
    storePath,
    cronEnabled,
    enqueueSystemEvent: (text, opts) => {
      const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
      const sessionKey = buildAgentMainSessionKey({ agentId });
      enqueueSystemEvent(text, { sessionKey });
    },
    requestHeartbeatNow,
    runHeartbeatOnce: deps.runHeartbeatOnce,
    runIsolatedAgentJob: async ({ job, message }) => await runIsolatedJob(deps, job, message),
    log: cronLog,
    onEvent: (evt) => {
      if (evt.action === "finished") {
        const logPath = resolveCronRunLogPath({ storePath, jobId: evt.jobId });
        void appendCronRunLog(logPath, {
          ts: Date.now(),
          jobId: evt.jobId,
          action: "finished",
          status: evt.status,
          error: evt.error,
          summary: evt.summary,
          runAtMs: evt.runAtMs,
          durationMs: evt.durationMs,
          nextRunAtMs: evt.nextRunAtMs,
        }).catch((err) => {
          log.warn("cron: run log append failed", { err: String(err), logPath });
        });
      }
    },
  });

  const add = async (input: unknown): Promise<CronJob> => {
    const normalized = normalizeCronJobCreate(input) ?? input;
    if (!normalized || typeof normalized !== "object") {
      throw new Error("invalid cron job input");
    }
    return await cron.add(normalized as CronJobCreate);
  };

  const update = async (input: unknown): Promise<CronJob> => {
    if (!input || typeof input !== "object") {
      throw new Error("invalid cron update input");
    }
    const candidate = input as { id?: string; jobId?: string; patch?: unknown };
    const jobId = candidate.id ?? candidate.jobId;
    if (!jobId) {
      throw new Error("invalid cron update input: missing jobId");
    }
    const normalizedPatch = normalizeCronJobPatch(candidate.patch) ?? candidate.patch;
    if (!normalizedPatch || typeof normalizedPatch !== "object") {
      throw new Error("invalid cron update input: patch required");
    }
    return await cron.update(jobId, normalizedPatch as CronJobPatch);
  };

  const listRuns = async (jobId: string, limit?: number) => {
    const logPath = resolveCronRunLogPath({ storePath, jobId });
    return await readCronRunLogEntries(logPath, { limit, jobId });
  };

  return {
    cron,
    storePath,
    cronEnabled,
    add,
    update,
    listRuns,
  };
}
