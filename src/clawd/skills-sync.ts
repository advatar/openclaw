import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { resolveUserPath } from "../utils.js";

export type SkillsSyncOptions = {
  prefix?: string;
  link?: boolean;
  dryRun?: boolean;
  userDir?: string;
  repoDir?: string;
  sourceDir?: string;
};

export type SkillsSyncResult = {
  sourceDir: string;
  targets: string[];
  synced: Array<{
    name: string;
    source: string;
    targets: string[];
  }>;
};

const DEFAULT_PREFIX = "oc-";

function defaultSourceDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../skills");
}

function normalizeName(raw: string): string {
  return raw.trim();
}

function truncateText(value: string, maxLen: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd();
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const block = normalized.slice(4, end);
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(block) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = {};
  }
  const body = normalized.slice(end + "\n---".length).replace(/^\n+/, "");
  return { frontmatter, body };
}

function buildFrontmatter(params: {
  base: Record<string, unknown>;
  name: string;
  description: string;
}): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.base)) {
    if (key === "name" || key === "description") {
      continue;
    }
    cleaned[key] = value;
  }
  return {
    name: params.name,
    description: params.description,
    ...cleaned,
  };
}

function resolveSkillName(params: { raw: string; prefix: string }): string {
  const base = normalizeName(params.raw) || "openclaw-skill";
  if (!params.prefix) {
    return base;
  }
  if (base.startsWith(params.prefix)) {
    return base;
  }
  return `${params.prefix}${base}`;
}

async function writeSkillDir(params: {
  sourceDir: string;
  targetDir: string;
  name: string;
  description: string;
  link: boolean;
  dryRun: boolean;
}) {
  if (params.dryRun) {
    return;
  }
  await fs.rm(params.targetDir, { recursive: true, force: true });
  await fs.mkdir(params.targetDir, { recursive: true });

  const entries = await fs.readdir(params.sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(params.sourceDir, entry.name);
    const dest = path.join(params.targetDir, entry.name);
    if (entry.isDirectory()) {
      if (params.link) {
        await fs.symlink(src, dest, "junction");
      } else {
        await fs.cp(src, dest, { recursive: true });
      }
      continue;
    }
    if (entry.isFile()) {
      if (entry.name === "SKILL.md") {
        const raw = await fs.readFile(src, "utf-8");
        const split = splitFrontmatter(raw);
        const nextFrontmatter = buildFrontmatter({
          base: split.frontmatter,
          name: params.name,
          description: params.description,
        });
        const yaml = YAML.stringify(nextFrontmatter).trimEnd();
        const body = split.body.trimStart();
        const next = `---\n${yaml}\n---\n\n${body}\n`;
        await fs.writeFile(dest, next, "utf-8");
        continue;
      }
      if (params.link) {
        await fs.symlink(src, dest);
      } else {
        await fs.copyFile(src, dest);
      }
    }
  }
}

export async function syncOpenClawSkills(
  options: SkillsSyncOptions = {},
): Promise<SkillsSyncResult> {
  const sourceDir = options.sourceDir ? resolveUserPath(options.sourceDir) : defaultSourceDir();
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const userDir = options.userDir
    ? resolveUserPath(options.userDir)
    : path.join(resolveUserPath("~/.codex/skills"), "openclaw");
  const repoDir = options.repoDir
    ? resolveUserPath(options.repoDir)
    : path.resolve(".codex/skills/openclaw");
  const targets = Array.from(new Set([userDir, repoDir]));

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const synced: SkillsSyncResult["synced"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillDir = path.join(sourceDir, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    let raw = "";
    try {
      raw = await fs.readFile(skillFile, "utf-8");
    } catch {
      continue;
    }
    const split = splitFrontmatter(raw);
    const rawName =
      typeof split.frontmatter.name === "string" && split.frontmatter.name.trim()
        ? split.frontmatter.name
        : entry.name;
    const rawDescription =
      typeof split.frontmatter.description === "string" && split.frontmatter.description.trim()
        ? split.frontmatter.description
        : `OpenClaw skill synced from ${entry.name}.`;
    const name = truncateText(resolveSkillName({ raw: rawName, prefix }), 100);
    const description = truncateText(rawDescription, 500);

    const targetDirs: string[] = [];
    for (const targetRoot of targets) {
      const targetDir = path.join(targetRoot, entry.name);
      targetDirs.push(targetDir);
      await writeSkillDir({
        sourceDir: skillDir,
        targetDir,
        name,
        description,
        link: options.link ?? false,
        dryRun: options.dryRun ?? false,
      });
    }

    synced.push({ name, source: skillDir, targets: targetDirs });
  }

  return { sourceDir, targets, synced };
}
