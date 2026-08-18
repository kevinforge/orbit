import assert from "node:assert/strict";
import test from "node:test";

import {
  AcpConnectionPool,
  type AcpReusableConnectionFactory,
} from "../src/core/acp-connection-pool.ts";
import type { AcpReusableConnection, AcpRuntimeDefinition } from "../src/core/acp-runtime.ts";

const definition: AcpRuntimeDefinition = {
  kind: "codebuddy",
  displayName: "CodeBuddy",
  buildCommand: () => ({ file: "codebuddy", args: ["--acp"] }),
};

function fakeFactory() {
  let spawnCount = 0;
  let initializeCount = 0;
  let closeCount = 0;
  const factory: AcpReusableConnectionFactory = () => {
    spawnCount += 1;
    let alive = true;
    const connection: AcpReusableConnection = {
      pid: spawnCount,
      async initialize() {
        initializeCount += 1;
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      },
      async newSession() { return { sessionId: "session-1" }; },
      async loadSession() {},
      async resumeSession() {},
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() { alive = false; closeCount += 1; },
      rebind() {},
      deactivate() {},
      isAlive() { return alive; },
    };
    return connection;
  };
  return {
    factory,
    stats: () => ({ spawnCount, initializeCount, closeCount }),
  };
}

function runOptions(poolKey = "conversation:agent") {
  return {
    agentId: "agent",
    poolKey,
    cwd: process.cwd(),
    prompt: "hello",
    approvalMode: "ask" as const,
  };
}

test("ACP pool reuses an initialized process and loaded session before TTL", async () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });
  const first = pool.acquire(definition, runOptions(), () => {});
  await first.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Orbit", version: "1" } });
  await first.newSession({ cwd: process.cwd(), mcpServers: [] });
  first.close();

  const second = pool.acquire(definition, runOptions(), () => {});
  await second.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "Orbit", version: "1" } });
  assert.equal(second.hasSession?.("session-1"), true);
  assert.deepEqual(fake.stats(), { spawnCount: 1, initializeCount: 1, closeCount: 0 });
  second.close();
  pool.dispose();
});

test("ACP pool isolates conversations and destroys failed leases", () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });
  const first = pool.acquire(definition, runOptions("conversation-1:agent"), () => {});
  first.close();
  const second = pool.acquire(definition, runOptions("conversation-2:agent"), () => {});
  second.destroy?.();

  assert.deepEqual(fake.stats(), { spawnCount: 2, initializeCount: 0, closeCount: 1 });
  pool.dispose();
});

test("ACP pool evicts an idle process after TTL", async () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 10 });
  const connection = pool.acquire(definition, runOptions(), () => {});
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(pool.size(), 0);
  assert.equal(fake.stats().closeCount, 1);
});

test("ACP pool enforces the idle limit after concurrent leases are released", () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000, maxIdleProcesses: 2 });
  const first = pool.acquire(definition, runOptions("conversation-1:agent"), () => {});
  const second = pool.acquire(definition, runOptions("conversation-2:agent"), () => {});
  const third = pool.acquire(definition, runOptions("conversation-3:agent"), () => {});

  first.close();
  second.close();
  third.close();

  assert.equal(pool.size(), 2);
  assert.equal(fake.stats().closeCount, 1);
  pool.dispose();
});
