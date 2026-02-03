import fs from "node:fs/promises";
import path from "node:path";
import type { CodexTurnResult } from "./codex/app-server.js";
import type { ClawdConfig, ClawdPaths } from "./config.js";
import type { ClawdRoute } from "./sessions.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  HEARTBEAT_PROMPT,
  isHeartbeatContentEffectivelyEmpty,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import {
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
  type HeartbeatRunResult,
} from "../infra/heartbeat-wake.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("clawd/heartbeat");

const ACTIVE_HOURS_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/;

function resolveActiveHoursTimezone(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user" || trimmed === "local") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return "UTC";
  }
}

function parseTimeMinutes(raw?: string, allow24 = false): number | null {
  if (!raw || !ACTIVE_HOURS_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveMinutesInZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function isWithinActiveHours(cfg: ClawdConfig, nowMs: number): boolean {
  const active = cfg.heartbeat?.activeHours;
  if (!active) {
    return true;
  }
  const start = parseTimeMinutes(active.start, false);
  const end = parseTimeMinutes(active.end, true);
  if (start === null || end === null) {
    return true;
  }
  if (start === end) {
    return true;
  }
  const timeZone = resolveActiveHoursTimezone(active.timezone);
  const minutes = resolveMinutesInZone(nowMs, timeZone);
  if (minutes === null) {
    return true;
  }
  if (end > start) {
    return minutes >= start && minutes < end;
  }
  return minutes >= start || minutes < end;
}

function formatSystemEvents(events: string[]): string {
  const lines = events
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) => `- ${event}`);
  if (lines.length === 0) {
    return "";
  }
  return `System events:\n${lines.join("\n")}\n\n`;
}

export type ClawdHeartbeatDeps = {
  config: ClawdConfig;
  paths: ClawdPaths;
  mainSessionKey: string;
  hasPendingTurns: () => boolean;
  ensureThread: (sessionKey: string) => Promise<string>;
  runTurn: (params: { threadId: string; text: string }) => Promise<CodexTurnResult>;
  getLastRoute: () => Promise<ClawdRoute | undefined>;
  sendMessage: (params: {
    channel: string;
    to: string;
    text: string;
    accountId?: string;
    sessionKey: string;
  }) => Promise<{ ok: boolean; error?: string }>;
};

export type ClawdHeartbeat = {
  start: () => void;
  stop: () => void;
  runOnce: (opts?: { reason?: string }) => Promise<HeartbeatRunResult>;
};

export function createClawdHeartbeat(deps: ClawdHeartbeatDeps): ClawdHeartbeat {
  let timer: NodeJS.Timeout | null = null;
  const intervalMs = Math.max(30_000, deps.config.heartbeat?.intervalMs ?? 30 * 60 * 1000);

  const runOnce = async (opts?: { reason?: string }): Promise<HeartbeatRunResult> => {
    if (deps.config.heartbeat?.enabled === false) {
      return { status: "skipped", reason: "disabled" };
    }
    if (!isWithinActiveHours(deps.config, Date.now())) {
      return { status: "skipped", reason: "outside active hours" };
    }
    if (deps.hasPendingTurns()) {
      return { status: "skipped", reason: "requests-in-flight" };
    }
    const heartbeatPath = path.join(deps.paths.workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
    let heartbeatContent: string | null = null;
    try {
      heartbeatContent = await fs.readFile(heartbeatPath, "utf-8");
      if (isHeartbeatContentEffectivelyEmpty(heartbeatContent)) {
        return { status: "skipped", reason: "empty heartbeat" };
      }
    } catch {
      // File missing -> still run heartbeat.
      heartbeatContent = null;
    }

    const systemEvents = drainSystemEvents(deps.mainSessionKey);
    const prompt = resolveHeartbeatPrompt(deps.config.heartbeat?.prompt ?? HEARTBEAT_PROMPT);
    const text = `${formatSystemEvents(systemEvents)}${prompt}`.trim();
    if (!text) {
      return { status: "skipped", reason: "empty prompt" };
    }

    const startedAt = Date.now();
    try {
      const threadId = await deps.ensureThread(deps.mainSessionKey);
      const result = await deps.runTurn({ threadId, text });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const output = result.outputText?.trim() ?? "";
      const ackChars = Math.max(
        0,
        deps.config.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
      );
      const stripped = stripHeartbeatToken(output, { mode: "heartbeat", maxAckChars: ackChars });
      if (stripped.shouldSkip) {
        return { status: "ran", durationMs };
      }

      const deliverText = stripped.text.trim();
      if (!deliverText) {
        return { status: "ran", durationMs };
      }

      const explicit = deps.config.heartbeat?.delivery;
      let channel = explicit?.channel;
      let to = explicit?.to;
      let accountId = explicit?.accountId;

      if (!channel || !to) {
        const last = await deps.getLastRoute();
        if (last) {
          channel = channel ?? last.channel;
          to = to ?? last.to;
          accountId = accountId ?? last.accountId;
        }
      }

      if (!channel || !to) {
        log.warn("heartbeat: no delivery target", { reason: opts?.reason });
        return { status: "ran", durationMs };
      }

      const delivered = await deps.sendMessage({
        channel,
        to,
        text: deliverText,
        accountId,
        sessionKey: deps.mainSessionKey,
      });
      if (!delivered.ok) {
        log.warn("heartbeat delivery failed", { err: delivered.error });
      }
      return { status: "ran", durationMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", reason: message };
    }
  };

  const tick = () => {
    void runOnce({ reason: "interval" }).finally(() => {
      if (timer) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    });
  };

  const start = () => {
    if (timer) {
      return;
    }
    setHeartbeatWakeHandler(runOnce);
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
  };

  const stop = () => {
    setHeartbeatWakeHandler(null);
    if (timer) {
      clearTimeout(timer);
    }
    timer = null;
  };

  return { start, stop, runOnce };
}

export function wakeHeartbeatNow(opts?: { reason?: string }) {
  requestHeartbeatNow({ reason: opts?.reason });
}
