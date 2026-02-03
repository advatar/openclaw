import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { ClawdPaths } from "./config.js";
import { memoryGet, memorySearch } from "./memory.js";

const buildPaths = (root: string, workspaceDir: string): ClawdPaths => ({
  stateDir: root,
  workspaceDir,
  configPath: path.join(root, "config.json"),
  cronStorePath: path.join(root, "cron", "jobs.json"),
  cronRunsDir: path.join(root, "cron", "runs"),
  sessionsPath: path.join(root, "sessions.json"),
  memoryDir: path.join(root, "memory"),
});

describe("clawd memory", () => {
  it("searches and reads memory files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawd-memory-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "alpha\nfoo bar\nbeta\n", "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-02-03.md"),
      "note about foo\n",
      "utf-8",
    );

    const paths = buildPaths(tempRoot, workspaceDir);
    const cfg = { memory: { enabled: true, citations: "off" } };

    const search = await memorySearch(cfg, paths, { query: "foo" });
    expect(search.results.length).toBeGreaterThan(0);

    const get = await memoryGet(cfg, paths, { path: "MEMORY.md", from: 2, lines: 1 });
    expect(get.text.trim()).toBe("foo bar");
  });
});
