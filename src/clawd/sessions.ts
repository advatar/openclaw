import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

export type ClawdRoute = {
  channel: string;
  to: string;
  accountId?: string;
  updatedAtMs: number;
};

export type ClawdSessionEntry = {
  threadId?: string;
  updatedAtMs: number;
  lastRoute?: ClawdRoute;
};

export type ClawdSessionStoreSnapshot = Record<string, ClawdSessionEntry>;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function coerceStore(raw: unknown): ClawdSessionStoreSnapshot {
  if (!isRecord(raw)) {
    return {};
  }
  const output: ClawdSessionStoreSnapshot = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !isRecord(value)) {
      continue;
    }
    const entry: ClawdSessionEntry = {
      threadId: typeof value.threadId === "string" ? value.threadId : undefined,
      updatedAtMs:
        typeof value.updatedAtMs === "number" && Number.isFinite(value.updatedAtMs)
          ? value.updatedAtMs
          : Date.now(),
    };
    const lastRouteRaw = value.lastRoute;
    if (isRecord(lastRouteRaw)) {
      if (typeof lastRouteRaw.channel === "string" && typeof lastRouteRaw.to === "string") {
        entry.lastRoute = {
          channel: lastRouteRaw.channel,
          to: lastRouteRaw.to,
          accountId:
            typeof lastRouteRaw.accountId === "string" ? lastRouteRaw.accountId : undefined,
          updatedAtMs:
            typeof lastRouteRaw.updatedAtMs === "number" &&
            Number.isFinite(lastRouteRaw.updatedAtMs)
              ? lastRouteRaw.updatedAtMs
              : entry.updatedAtMs,
        };
      }
    }
    output[normalizeKey(key)] = entry;
  }
  return output;
}

export class ClawdSessionStore {
  private store: ClawdSessionStoreSnapshot | null = null;
  private op: Promise<unknown> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  async get(sessionKey: string): Promise<ClawdSessionEntry | undefined> {
    const key = normalizeKey(sessionKey);
    await this.ensureLoaded();
    return this.store?.[key];
  }

  async setThreadId(sessionKey: string, threadId: string): Promise<ClawdSessionEntry> {
    const key = normalizeKey(sessionKey);
    return await this.update((store) => {
      const existing = store[key];
      const updated: ClawdSessionEntry = {
        threadId,
        updatedAtMs: Date.now(),
        lastRoute: existing?.lastRoute,
      };
      store[key] = updated;
      return updated;
    });
  }

  async setLastRoute(sessionKey: string, route: Omit<ClawdRoute, "updatedAtMs">) {
    const key = normalizeKey(sessionKey);
    return await this.update((store) => {
      const existing = store[key];
      const now = Date.now();
      const updated: ClawdSessionEntry = {
        threadId: existing?.threadId,
        updatedAtMs: now,
        lastRoute: {
          channel: route.channel,
          to: route.to,
          accountId: route.accountId,
          updatedAtMs: now,
        },
      };
      store[key] = updated;
      return updated;
    });
  }

  async list(): Promise<ClawdSessionStoreSnapshot> {
    await this.ensureLoaded();
    const store = this.store ?? {};
    return { ...store };
  }

  async getLastRoute(sessionKey: string): Promise<ClawdRoute | undefined> {
    const entry = await this.get(sessionKey);
    return entry?.lastRoute;
  }

  private async ensureLoaded() {
    if (this.store) {
      return;
    }
    const raw = loadJsonFile(this.storePath);
    this.store = coerceStore(raw);
  }

  private async update<T>(fn: (store: ClawdSessionStoreSnapshot) => T): Promise<T> {
    this.op = this.op
      .catch(() => undefined)
      .then(async () => {
        await this.ensureLoaded();
        const store = this.store ?? {};
        const result = fn(store);
        this.store = store;
        saveJsonFile(this.storePath, store);
        return result;
      });
    return (await this.op) as T;
  }
}
