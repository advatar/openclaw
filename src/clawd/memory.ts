import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { MemorySearchResult } from "../memory/types.js";
import type { ClawdConfig, ClawdPaths } from "./config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { isMemoryPath, listMemoryFiles, normalizeRelPath } from "../memory/internal.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { resolveClawdAgentDir } from "./config.js";

export type ClawdMemorySearchParams = {
  query: string;
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
};

export type ClawdMemoryGetParams = {
  path: string;
  from?: number;
  lines?: number;
};

export type ClawdMemorySearchResponse = {
  results: MemorySearchResult[];
  provider?: string;
  model?: string;
  fallback?: unknown;
  citations?: "auto" | "on" | "off";
  disabled?: boolean;
  error?: string;
};

export type ClawdMemoryGetResponse = {
  path: string;
  text: string;
  disabled?: boolean;
  error?: string;
};

function buildMemoryConfig(paths: ClawdPaths, cfg: ClawdConfig, agentId: string): OpenClawConfig {
  const resolvedId = normalizeAgentId(agentId || DEFAULT_AGENT_ID);
  const storePath = path.join(paths.memoryDir, `${resolvedId}.sqlite`);
  return {
    agents: {
      defaults: {
        workspace: paths.workspaceDir,
        memorySearch: {
          enabled: true,
          sources: ["memory"],
          store: {
            path: storePath,
            vector: { enabled: true },
          },
        },
      },
      list: [
        {
          id: resolvedId,
          default: true,
          workspace: paths.workspaceDir,
          agentDir: resolveClawdAgentDir(paths, resolvedId),
          memorySearch: {
            enabled: true,
            sources: ["memory"],
            store: {
              path: storePath,
              vector: { enabled: true },
            },
          },
        },
      ],
    },
    memory: {
      backend: "builtin",
      citations: cfg.memory?.citations ?? "auto",
    },
  };
}

function normalizeQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function shouldIncludeCitations(params: { mode: "auto" | "on" | "off"; sessionKey?: string }) {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed?.rest) {
    return true;
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":"));
  if (tokens.has("channel") || tokens.has("group")) {
    return false;
  }
  return true;
}

async function naiveSearch(params: {
  paths: ClawdPaths;
  query: string;
  maxResults: number;
  minScore: number;
  citations: "auto" | "on" | "off";
  sessionKey?: string;
}): Promise<ClawdMemorySearchResponse> {
  const files = await listMemoryFiles(params.paths.workspaceDir, []);
  const tokens = normalizeQueryTokens(params.query);
  if (tokens.length === 0) {
    return { results: [] };
  }
  const results: MemorySearchResult[] = [];
  const includeCitations = shouldIncludeCitations({
    mode: params.citations,
    sessionKey: params.sessionKey,
  });
  for (const filePath of files) {
    const relPath = path.relative(params.paths.workspaceDir, filePath).replace(/\\/g, "/");
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const window = 2;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lower = line.toLowerCase();
      let matched = 0;
      for (const token of tokens) {
        if (lower.includes(token)) {
          matched += 1;
        }
      }
      if (matched === 0) {
        continue;
      }
      const score = matched / tokens.length;
      if (score < params.minScore) {
        continue;
      }
      const startLine = Math.max(1, i + 1 - window);
      const endLine = Math.min(lines.length, i + 1 + window);
      const snippet = lines.slice(startLine - 1, endLine).join("\n");
      const entry: MemorySearchResult = {
        path: relPath,
        startLine,
        endLine,
        score,
        snippet,
        source: "memory",
      };
      if (includeCitations) {
        entry.citation = formatCitation(entry);
      }
      results.push(entry);
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, params.maxResults) };
}

async function naiveGet(params: {
  paths: ClawdPaths;
  relPath: string;
  from?: number;
  lines?: number;
}) {
  const relPath = normalizeRelPath(params.relPath);
  if (!relPath || !isMemoryPath(relPath)) {
    throw new Error("path required");
  }
  const absPath = path.resolve(params.paths.workspaceDir, relPath);
  const safeRel = path.relative(params.paths.workspaceDir, absPath).replace(/\\/g, "/");
  if (!safeRel || safeRel.startsWith("..")) {
    throw new Error("path required");
  }
  const content = await fs.readFile(absPath, "utf-8");
  if (!params.from && !params.lines) {
    return { path: relPath, text: content };
  }
  const lines = content.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const count = Math.max(1, params.lines ?? lines.length);
  const slice = lines.slice(start - 1, start - 1 + count);
  return { path: relPath, text: slice.join("\n") };
}

export async function memorySearch(
  cfg: ClawdConfig,
  paths: ClawdPaths,
  params: ClawdMemorySearchParams,
): Promise<ClawdMemorySearchResponse> {
  if (!cfg.memory?.enabled) {
    return { results: [], disabled: true, error: "memory disabled" };
  }
  const query = params.query.trim();
  if (!query) {
    return { results: [] };
  }
  const maxResults = Math.max(1, Math.min(50, Math.floor(params.maxResults ?? 6)));
  const minScore = Math.max(0, Math.min(1, params.minScore ?? 0));
  const citations = cfg.memory?.citations ?? "auto";
  const agentId = DEFAULT_AGENT_ID;
  const ocConfig = buildMemoryConfig(paths, cfg, agentId);
  const { manager } = await getMemorySearchManager({ cfg: ocConfig, agentId });
  if (!manager) {
    return await naiveSearch({
      paths,
      query,
      maxResults,
      minScore,
      citations,
      sessionKey: params.sessionKey,
    });
  }
  try {
    const raw = await manager.search(query, {
      maxResults,
      minScore,
      sessionKey: params.sessionKey,
    });
    const status = manager.status();
    const includeCitations = shouldIncludeCitations({
      mode: citations,
      sessionKey: params.sessionKey,
    });
    const results = includeCitations
      ? raw.map((entry) => ({
          ...entry,
          citation: entry.citation ?? formatCitation(entry),
        }))
      : raw;
    return {
      results,
      provider: status.provider,
      model: status.model,
      fallback: status.fallback,
      citations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      results: [],
      disabled: true,
      error: message,
    };
  }
}

export async function memoryGet(
  cfg: ClawdConfig,
  paths: ClawdPaths,
  params: ClawdMemoryGetParams,
): Promise<ClawdMemoryGetResponse> {
  if (!cfg.memory?.enabled) {
    return { path: params.path, text: "", disabled: true, error: "memory disabled" };
  }
  const agentId = DEFAULT_AGENT_ID;
  const ocConfig = buildMemoryConfig(paths, cfg, agentId);
  const { manager } = await getMemorySearchManager({ cfg: ocConfig, agentId });
  if (!manager) {
    try {
      return await naiveGet({
        paths,
        relPath: params.path,
        from: params.from,
        lines: params.lines,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { path: params.path, text: "", disabled: true, error: message };
    }
  }
  try {
    const result = await manager.readFile({
      relPath: params.path,
      from: params.from ?? undefined,
      lines: params.lines ?? undefined,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: params.path, text: "", disabled: true, error: message };
  }
}

export function memoryStatus(cfg: ClawdConfig, paths: ClawdPaths) {
  const agentId = DEFAULT_AGENT_ID;
  const ocConfig = buildMemoryConfig(paths, cfg, agentId);
  return resolveMemoryBackendConfig({ cfg: ocConfig, agentId });
}
