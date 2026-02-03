import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { syncOpenClawSkills } from "./skills-sync.js";

function parseFrontmatter(content: string): Record<string, unknown> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return {};
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }
  const block = normalized.slice(4, end);
  const parsed = YAML.parse(block) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

describe("clawd skills sync", () => {
  it("syncs skill frontmatter with prefix and description", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawd-skill-sync-"));
    const sourceDir = path.join(tempRoot, "source");
    const targetUser = path.join(tempRoot, "user");
    const targetRepo = path.join(tempRoot, "repo");
    await fs.mkdir(sourceDir, { recursive: true });

    const skillDir = path.join(sourceDir, "demo");
    await fs.mkdir(skillDir, { recursive: true });
    const skillContent = `---\nname: demo-skill\ndescription: Example description.\nmetadata: {openclaw: {emoji: "wrench"}}\n---\n\n# Demo\n`;
    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");
    await fs.writeFile(path.join(skillDir, "tool.sh"), "echo hi", "utf-8");

    const report = await syncOpenClawSkills({
      sourceDir,
      userDir: targetUser,
      repoDir: targetRepo,
      prefix: "oc-",
    });

    expect(report.synced.length).toBe(1);

    const syncedSkill = report.synced[0];
    if (!syncedSkill) {
      throw new Error("missing synced skill");
    }

    for (const target of syncedSkill.targets) {
      const nextSkill = await fs.readFile(path.join(target, "SKILL.md"), "utf-8");
      const frontmatter = parseFrontmatter(nextSkill);
      expect(frontmatter.name).toBe("oc-demo-skill");
      expect(frontmatter.description).toBe("Example description.");
      await fs.access(path.join(target, "tool.sh"));
    }
  });
});
