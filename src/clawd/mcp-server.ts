import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { wakeHeartbeatNow } from "./heartbeat.js";
import { memoryGet, memorySearch } from "./memory.js";
import { createClawdRuntime } from "./runtime.js";

const log = createSubsystemLogger("clawd/mcp");

const CronJobSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    enabled: { type: "boolean" },
    deleteAfterRun: { type: "boolean" },
    schedule: { type: "object", additionalProperties: true },
    sessionTarget: { type: "string", enum: ["main", "isolated"] },
    wakeMode: { type: "string", enum: ["now", "next-heartbeat"] },
    payload: { type: "object", additionalProperties: true },
    isolation: { type: "object", additionalProperties: true },
    agentId: { type: "string" },
  },
  additionalProperties: true,
};

const tools = [
  {
    name: "cron.list",
    description: "List cron jobs",
    inputSchema: {
      type: "object",
      properties: { includeDisabled: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "cron.status",
    description: "Get cron scheduler status",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cron.add",
    description: "Create a cron job (OpenClaw schema)",
    inputSchema: CronJobSchema,
  },
  {
    name: "cron.update",
    description: "Update a cron job (OpenClaw schema)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        jobId: { type: "string" },
        patch: { type: "object", additionalProperties: true },
      },
      additionalProperties: true,
    },
  },
  {
    name: "cron.remove",
    description: "Remove a cron job",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, jobId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "cron.run",
    description: "Run a cron job",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        jobId: { type: "string" },
        mode: { type: "string", enum: ["due", "force"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cron.runs",
    description: "Fetch cron job run history",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        jobId: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Search MEMORY.md + memory/*.md",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        minScore: { type: "number" },
        sessionKey: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    description: "Read MEMORY.md or memory/*.md",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        from: { type: "number" },
        lines: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "message.send",
    description: "Send a message via OpenClaw Gateway",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        message: { type: "string" },
        accountId: { type: "string" },
        sessionKey: { type: "string" },
        bestEffort: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "channels.list",
    description: "List configured channels (stub)",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "channels.resolve_target",
    description: "Resolve a channel target (stub)",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        to: { type: "string" },
        accountId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "heartbeat.wake",
    description: "Trigger a heartbeat run",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      additionalProperties: false,
    },
  },
];

function formatResult(payload: unknown, opts?: { isError?: boolean }) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: opts?.isError ?? false,
  } as const;
}

export async function runClawdMcpServer(opts?: {
  enableCron?: boolean;
  enableHeartbeat?: boolean;
}) {
  const runtime = await createClawdRuntime({
    enableCron: opts?.enableCron ?? true,
    enableHeartbeat: opts?.enableHeartbeat ?? true,
  });
  runtime.startSchedulers();

  const server = new Server(
    {
      name: "clawd",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case "cron.list": {
          const includeDisabled =
            typeof (args as { includeDisabled?: unknown }).includeDisabled === "boolean"
              ? (args as { includeDisabled?: boolean }).includeDisabled
              : undefined;
          const jobs = await runtime.cron.cron.list({ includeDisabled });
          return formatResult({ jobs });
        }
        case "cron.status": {
          const status = await runtime.cron.cron.status();
          return formatResult(status);
        }
        case "cron.add": {
          const job = await runtime.cron.add(args);
          return formatResult(job);
        }
        case "cron.update": {
          const job = await runtime.cron.update(args);
          return formatResult(job);
        }
        case "cron.remove": {
          const p = args as { id?: string; jobId?: string };
          const jobId = p.id ?? p.jobId;
          if (!jobId) {
            throw new Error("missing jobId");
          }
          const result = await runtime.cron.cron.remove(jobId);
          return formatResult(result);
        }
        case "cron.run": {
          const p = args as { id?: string; jobId?: string; mode?: "due" | "force" };
          const jobId = p.id ?? p.jobId;
          if (!jobId) {
            throw new Error("missing jobId");
          }
          const result = await runtime.cron.cron.run(jobId, p.mode);
          return formatResult(result);
        }
        case "cron.runs": {
          const p = args as { id?: string; jobId?: string; limit?: number };
          const jobId = p.id ?? p.jobId;
          if (!jobId) {
            throw new Error("missing jobId");
          }
          const entries = await runtime.cron.listRuns(jobId, p.limit);
          return formatResult({ entries });
        }
        case "memory_search": {
          const p = args as {
            query?: string;
            maxResults?: number;
            minScore?: number;
            sessionKey?: string;
          };
          if (!p.query) {
            throw new Error("missing query");
          }
          const result = await memorySearch(runtime.config, runtime.paths, {
            query: p.query,
            maxResults: p.maxResults,
            minScore: p.minScore,
            sessionKey: p.sessionKey,
          });
          return formatResult(result);
        }
        case "memory_get": {
          const p = args as { path?: string; from?: number; lines?: number };
          if (!p.path) {
            throw new Error("missing path");
          }
          const result = await memoryGet(runtime.config, runtime.paths, {
            path: p.path,
            from: p.from,
            lines: p.lines,
          });
          return formatResult(result);
        }
        case "message.send": {
          const p = args as {
            channel?: string;
            to?: string;
            text?: string;
            message?: string;
            accountId?: string;
            sessionKey?: string;
            dryRun?: boolean;
            bestEffort?: boolean;
          };
          const channel = p.channel?.trim();
          const to = p.to?.trim();
          const text = (p.text ?? p.message ?? "").trim();
          if (!channel || !to || !text) {
            throw new Error("channel, to, and text are required");
          }
          if (p.dryRun) {
            return formatResult({ ok: true, dryRun: true });
          }
          const result = await runtime.sendMessage({
            channel,
            to,
            text,
            accountId: p.accountId,
            sessionKey: p.sessionKey,
          });
          if (!result.ok && p.bestEffort) {
            return formatResult({ ok: false, error: result.error, bestEffort: true });
          }
          if (!result.ok) {
            throw new Error(result.error ?? "message send failed");
          }
          return formatResult({ ok: true, result: result.result });
        }
        case "channels.list": {
          return formatResult({ channels: [], disabled: true });
        }
        case "channels.resolve_target": {
          const p = args as { channel?: string; to?: string; accountId?: string };
          return formatResult({
            channel: p.channel,
            to: p.to,
            accountId: p.accountId,
          });
        }
        case "heartbeat.wake": {
          const p = args as { reason?: string };
          wakeHeartbeatNow({ reason: p.reason });
          return formatResult({ ok: true });
        }
        default:
          throw new Error(`unknown tool: ${name}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("mcp tool failed", { err: message, tool: name });
      return formatResult({ error: message }, { isError: true });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
