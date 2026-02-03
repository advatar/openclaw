import type { Command } from "commander";
import { runClawdMcpServer } from "../../clawd/mcp-server.js";
import { runClawdDaemon } from "../../clawd/runtime.js";
import { syncOpenClawSkills } from "../../clawd/skills-sync.js";
import { defaultRuntime } from "../../runtime.js";

export function registerClawdCli(program: Command) {
  const clawd = program.command("clawd").description("Codex + OpenClaw compatibility runtime");

  clawd
    .command("mcp-server")
    .description("Run the clawd MCP server (cron + memory + messaging)")
    .option("--no-cron", "Disable cron scheduler")
    .option("--no-heartbeat", "Disable heartbeat loop")
    .action(async (opts) => {
      await runClawdMcpServer({
        enableCron: Boolean(opts.cron),
        enableHeartbeat: Boolean(opts.heartbeat),
      });
    });

  clawd
    .command("daemon")
    .description("Run the clawd daemon (cron + heartbeat)")
    .action(async () => {
      await runClawdDaemon();
    });

  const skills = clawd.command("skills").description("Manage OpenClaw skills for Codex");
  skills
    .command("sync")
    .description("Sync OpenClaw skills into Codex skill directories")
    .option("--prefix <prefix>", "Prefix for skill names", "oc-")
    .option("--link", "Symlink skill assets instead of copying", false)
    .option("--dry-run", "Preview changes without writing", false)
    .option("--user-dir <dir>", "Target user skills directory")
    .option("--repo-dir <dir>", "Target repo skills directory")
    .option("--source-dir <dir>", "Source OpenClaw skills directory")
    .action(async (opts) => {
      const report = await syncOpenClawSkills({
        prefix: opts.prefix,
        link: Boolean(opts.link),
        dryRun: Boolean(opts.dryRun),
        userDir: opts.userDir,
        repoDir: opts.repoDir,
        sourceDir: opts.sourceDir,
      });
      const summary = `Synced ${report.synced.length} skills to ${report.targets.join(", ")}.`;
      defaultRuntime.log(opts.dryRun ? `[dry-run] ${summary}` : summary);
    });
}
