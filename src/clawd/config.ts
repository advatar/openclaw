import JSON5 from "json5";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUserPath } from "../utils.js";

export type ClawdCodexConfig = {
  command?: string;
  args?: string[];
  cwd?: string;
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
  modelProvider?: string;
  autoApprove?: boolean;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
};

export type ClawdCronConfig = {
  enabled?: boolean;
  storePath?: string;
};

export type ClawdHeartbeatConfig = {
  enabled?: boolean;
  intervalMs?: number;
  prompt?: string;
  ackMaxChars?: number;
  activeHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  delivery?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
};

export type ClawdMemoryConfig = {
  enabled?: boolean;
  citations?: "auto" | "on" | "off";
};

export type ClawdGatewayConfig = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

export type ClawdSessionsConfig = {
  storePath?: string;
};

export type ClawdConfig = {
  codex?: ClawdCodexConfig;
  cron?: ClawdCronConfig;
  heartbeat?: ClawdHeartbeatConfig;
  memory?: ClawdMemoryConfig;
  gateway?: ClawdGatewayConfig;
  sessions?: ClawdSessionsConfig;
};

export type ClawdPaths = {
  stateDir: string;
  workspaceDir: string;
  configPath: string;
  cronStorePath: string;
  cronRunsDir: string;
  sessionsPath: string;
  memoryDir: string;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

const DEFAULT_CONFIG: ClawdConfig = {
  codex: {
    command: "codex",
    args: [],
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    autoApprove: false,
  },
  cron: {
    enabled: true,
  },
  heartbeat: {
    enabled: true,
    intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  },
  memory: {
    enabled: true,
    citations: "auto",
  },
};

function resolveHomeDir(homedir: () => string = os.homedir): string {
  try {
    const home = homedir();
    return home?.trim() ? home : os.homedir();
  } catch {
    return os.homedir();
  }
}

export function resolveClawdStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.CODEX_CLAWD_STATE_DIR?.trim() || env.CODEX_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(resolveHomeDir(homedir), ".codex", "clawd");
}

export function resolveClawdWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  stateDir?: string,
): string {
  const override = env.CODEX_CLAWD_WORKSPACE_DIR?.trim() || env.CODEX_WORKSPACE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  const root = stateDir ?? resolveClawdStateDir(env, homedir);
  return path.join(root, "workspace");
}

export function resolveClawdConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  stateDir?: string,
): string {
  const override = env.CODEX_CLAWD_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  const root = stateDir ?? resolveClawdStateDir(env, homedir);
  return path.join(root, "config.json");
}

export function resolveClawdPaths(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  config?: ClawdConfig;
}): ClawdPaths {
  const env = params?.env ?? process.env;
  const homedir = params?.homedir ?? os.homedir;
  const stateDir = resolveClawdStateDir(env, homedir);
  const workspaceDir = resolveClawdWorkspaceDir(env, homedir, stateDir);
  const configPath = resolveClawdConfigPath(env, homedir, stateDir);
  const cronStorePath = params?.config?.cron?.storePath
    ? resolveUserPath(params.config.cron.storePath)
    : path.join(stateDir, "cron", "jobs.json");
  const sessionsPath = params?.config?.sessions?.storePath
    ? resolveUserPath(params.config.sessions.storePath)
    : path.join(stateDir, "sessions.json");
  const cronRunsDir = path.join(path.dirname(cronStorePath), "runs");
  const memoryDir = path.join(stateDir, "memory");
  return {
    stateDir,
    workspaceDir,
    configPath,
    cronStorePath,
    cronRunsDir,
    sessionsPath,
    memoryDir,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfig(base: ClawdConfig, input: unknown): ClawdConfig {
  if (!isRecord(input)) {
    return base;
  }
  const codex = isRecord(input.codex) ? input.codex : {};
  const cron = isRecord(input.cron) ? input.cron : {};
  const heartbeat = isRecord(input.heartbeat) ? input.heartbeat : {};
  const memory = isRecord(input.memory) ? input.memory : {};
  const gateway = isRecord(input.gateway) ? input.gateway : {};
  const sessions = isRecord(input.sessions) ? input.sessions : {};
  return {
    ...base,
    codex: {
      ...base.codex,
      ...codex,
    },
    cron: {
      ...base.cron,
      ...cron,
    },
    heartbeat: {
      ...base.heartbeat,
      ...heartbeat,
    },
    memory: {
      ...base.memory,
      ...memory,
    },
    gateway: {
      ...base.gateway,
      ...gateway,
    },
    sessions: {
      ...base.sessions,
      ...sessions,
    },
  };
}

export async function loadClawdConfig(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
}): Promise<{ config: ClawdConfig; paths: ClawdPaths }> {
  const env = params?.env ?? process.env;
  const homedir = params?.homedir ?? os.homedir;
  const configPath = params?.configPath ?? resolveClawdConfigPath(env, homedir);
  let parsed: unknown = null;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    parsed = JSON5.parse(raw);
  } catch {
    parsed = null;
  }
  const config = mergeConfig(DEFAULT_CONFIG, parsed);
  const paths = resolveClawdPaths({ env, homedir, config });
  return { config, paths };
}

export async function ensureClawdDirs(paths: ClawdPaths) {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  await fs.mkdir(paths.memoryDir, { recursive: true });
  await fs.mkdir(path.dirname(paths.cronStorePath), { recursive: true });
  await fs.mkdir(paths.cronRunsDir, { recursive: true });
}

export function resolveClawdAgentDir(paths: ClawdPaths, agentId: string) {
  return path.join(paths.stateDir, "agents", agentId, "agent");
}
