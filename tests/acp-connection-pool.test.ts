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
  let destroyCount = 0;
  const connections: AcpReusableConnection[] = [];
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
      async loadSession() { return {}; },
      async resumeSession() { return {}; },
      async setConfigOption() { return { configOptions: [] }; },
      async prompt() { return { stopReason: "end_turn" }; },
      async cancel() {},
      close() { alive = false; closeCount += 1; },
      destroy() { alive = false; destroyCount += 1; },
      rebind() {},
      deactivate() {},
      isAlive() { return alive; },
    };
    connections.push(connection);
    return connection;
  };
  return {
    factory,
    stats: () => ({ spawnCount, initializeCount, closeCount, destroyCount }),
    // 模拟 stdout EOF：进程标志位仍活，但传输已断（issue #141 的 isAlive 语义）。
    endTransports: () => {
      for (const connection of connections) connection.isAlive = () => false;
    },
  };
}

function runOptions(poolKey = "conversation:agent", env?: NodeJS.ProcessEnv) {
  return {
    agentId: "agent",
    poolKey,
    cwd: process.cwd(),
    prompt: "hello",
    approvalMode: "ask" as const,
    env,
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
  assert.deepEqual(fake.stats(), { spawnCount: 1, initializeCount: 1, closeCount: 0, destroyCount: 0 });
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

  assert.deepEqual(fake.stats(), { spawnCount: 2, initializeCount: 0, closeCount: 0, destroyCount: 1 });
  pool.dispose();
});

test("destroying a lease terminates the underlying process and never returns it to the idle pool", () => {
  // Issue #136：强制销毁走底层 destroy（终止进程并结束 pending 请求），
  // 连接不回空闲池，后续获取必须启动新进程。
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });
  const connection = pool.acquire(definition, runOptions(), () => {});
  connection.destroy?.();

  assert.deepEqual(fake.stats(), { spawnCount: 1, initializeCount: 0, closeCount: 0, destroyCount: 1 });
  assert.equal(pool.size(), 0, "销毁的连接不得留在空闲池中");

  const next = pool.acquire(definition, runOptions(), () => {});
  assert.equal(fake.stats().spawnCount, 2, "再次获取必须启动新进程");
  next.destroy?.();
});

test("ACP pool evicts an idle process after TTL", async () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 10 });
  const connection = pool.acquire(definition, runOptions(), () => {});
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(pool.size(), 0);
  assert.equal(fake.stats().destroyCount, 1);
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
  assert.equal(fake.stats().destroyCount, 1);
  pool.dispose();
});

test("ACP pool keys proxy environment changes so stale routes are not reused", () => {
  // Issue #141：切换代理后旧连接仍走旧出口，必须另起新进程；代理值相同
  // （含大小写变体归一）时仍复用同一条连接。
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });

  const first = pool.acquire(definition, runOptions("c:agent", { HTTP_PROXY: "http://127.0.0.1:7890" }), () => {});
  first.close();
  const second = pool.acquire(definition, runOptions("c:agent", { HTTP_PROXY: "http://127.0.0.1:7890" }), () => {});
  second.close();
  assert.equal(fake.stats().spawnCount, 1, "代理值未变化时必须复用连接");

  const third = pool.acquire(definition, runOptions("c:agent", { HTTP_PROXY: "http://127.0.0.1:7891", NO_PROXY: "localhost" }), () => {});
  assert.equal(fake.stats().spawnCount, 2, "代理值变化后必须另起新进程");
  assert.equal(pool.size(), 2);
  third.close();
  pool.dispose();
});

test("ACP pool treats lowercase proxy variants as the same key when values match", () => {
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });

  const first = pool.acquire(definition, runOptions("c:agent", { http_proxy: "http://127.0.0.1:7890" }), () => {});
  first.close();
  const second = pool.acquire(definition, runOptions("c:agent", { HTTP_PROXY: "http://127.0.0.1:7890" }), () => {});
  second.close();

  assert.equal(fake.stats().spawnCount, 1, "仅大小写不同的代理变量是同一个键");
  pool.dispose();
});

test("ACP pool does not reuse a connection whose stdout transport has ended", () => {
  // Issue #141：进程活着但传输断开（stdout EOF）的连接不可复用。
  const fake = fakeFactory();
  const pool = new AcpConnectionPool(fake.factory, { ttlMs: 1_000 });

  const first = pool.acquire(definition, runOptions("c:agent"), () => {});
  first.close();
  fake.endTransports();

  const second = pool.acquire(definition, runOptions("c:agent"), () => {});
  assert.equal(fake.stats().spawnCount, 2, "传输已断开的空闲连接必须被销毁并另起新进程");
  second.close();
  pool.dispose();
});
