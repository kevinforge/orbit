import path from "node:path";

import type { InitializeResponse, SessionNotification } from "@agentclientprotocol/sdk";

import type {
  AcpConnection,
  AcpReusableConnection,
  AcpRunOptions,
  AcpRuntimeDefinition,
} from "./acp-runtime.ts";

export const DEFAULT_ACP_PROCESS_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_IDLE_PROCESSES = 8;

type Entry = {
  key: string;
  connection: AcpReusableConnection;
  initialized?: Promise<InitializeResponse>;
  sessions: Set<string>;
  leased: boolean;
  lastUsedAt: number;
  timer?: NodeJS.Timeout;
};

export type AcpReusableConnectionFactory = (
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
) => AcpReusableConnection;

export type AcpConnectionPoolOptions = {
  ttlMs?: number;
  maxIdleProcesses?: number;
  now?: () => number;
};

export class AcpConnectionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxIdleProcesses: number;
  private readonly now: () => number;

  constructor(
    private readonly factory: AcpReusableConnectionFactory,
    options: AcpConnectionPoolOptions = {},
  ) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_ACP_PROCESS_TTL_MS);
    this.maxIdleProcesses = Math.max(1, options.maxIdleProcesses ?? DEFAULT_MAX_IDLE_PROCESSES);
    this.now = options.now ?? Date.now;
  }

  acquire(
    definition: AcpRuntimeDefinition,
    options: AcpRunOptions,
    onSessionUpdate: (notification: SessionNotification) => void,
  ): AcpConnection {
    const key = connectionKey(definition, options);
    let entry = this.entries.get(key);
    if (entry && (entry.leased || !entry.connection.isAlive())) {
      if (!entry.leased) this.destroyEntry(entry);
      entry = undefined;
    }

    if (!entry) {
      this.evictIdleOverflow();
      entry = {
        key,
        connection: this.factory(definition, options, onSessionUpdate),
        sessions: new Set(),
        leased: false,
        lastUsedAt: this.now(),
      };
      this.entries.set(key, entry);
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.leased = true;
    entry.connection.rebind(options, onSessionUpdate);
    return this.createLease(entry);
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      this.destroyEntry(entry);
    }
  }

  size(): number {
    return this.entries.size;
  }

  private createLease(entry: Entry): AcpConnection {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.connection.deactivate();
      entry.leased = false;
      entry.lastUsedAt = this.now();
      if (this.entries.get(entry.key) !== entry) {
        entry.connection.close();
        return;
      }
      this.trimIdleProcesses(this.maxIdleProcesses);
      if (this.ttlMs === 0) {
        this.destroyEntry(entry);
        return;
      }
      if (this.entries.get(entry.key) !== entry) return;
      entry.timer = setTimeout(() => this.destroyEntry(entry), this.ttlMs);
      entry.timer.unref?.();
    };
    const destroy = () => {
      if (released) return;
      released = true;
      this.destroyEntry(entry);
    };

    return {
      pid: entry.connection.pid,
      initialize: (request) => {
        entry.initialized ??= entry.connection.initialize(request);
        return entry.initialized;
      },
      newSession: async (request) => {
        const created = await entry.connection.newSession(request);
        entry.sessions.add(created.sessionId);
        return created;
      },
      loadSession: async (request) => {
        await entry.connection.loadSession(request);
        entry.sessions.add(request.sessionId);
      },
      resumeSession: async (request) => {
        await entry.connection.resumeSession(request);
        entry.sessions.add(request.sessionId);
      },
      prompt: (request) => entry.connection.prompt(request),
      cancel: (sessionId) => entry.connection.cancel(sessionId),
      hasSession: (sessionId) => entry.sessions.has(sessionId),
      close: release,
      destroy,
    };
  }

  private evictIdleOverflow(): void {
    this.trimIdleProcesses(this.maxIdleProcesses - 1);
  }

  private trimIdleProcesses(limit: number): void {
    const idle = [...this.entries.values()]
      .filter((entry) => !entry.leased)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (idle.length > Math.max(0, limit)) {
      this.destroyEntry(idle.shift()!);
    }
  }

  private destroyEntry(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    entry.connection.close();
  }
}

function connectionKey(definition: AcpRuntimeDefinition, options: AcpRunOptions): string {
  const baseEnv = options.env ?? process.env;
  const command = definition.buildCommand(baseEnv);
  const runEnv = definition.envForRun?.(options) ?? {};
  return JSON.stringify({
    runtime: definition.kind,
    cwd: path.resolve(options.cwd),
    owner: options.poolKey ?? options.agentId,
    approvalMode: options.approvalMode ?? "ask",
    command: [command.file, ...command.args],
    runEnv: Object.entries(runEnv).sort(([left], [right]) => left.localeCompare(right)),
  });
}
