import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "../src/core/agent-registry.ts";
import type { AgentRuntime, AgentRuntimeRunOptions } from "../src/core/agent-runtime.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";
import { probeAgentCommands, type CommandProbeEvent } from "../src/server/command-probe.ts";
import type { AcpRuntimeDefinition } from "../src/core/acp-runtime.ts";
import type { AgentCommand, RuntimeEvent } from "../src/shared/types.ts";

/**
 * 斜杠命令主动探测（issue #160 收尾 + 二轮 review）。
 *
 * ACP 没有独立的“命令列表”请求，命令由 runtime 会话建立时推送。探测是
 * 异步的，等待期间员工的正式会话可能建立并通告真实命令——二轮 review
 * 指出旧实现广播探测结果不看写回是否被采纳，会让迟到的探测帧在 UI 上
 * 覆盖真实命令，菜单展示与服务端白名单分叉。这里对 probeAgentCommands
 * 做真实行为测试：用受控 Promise 把“探测途中正式通告先到”交错出来，
 * 断言广播与返回值都以权威快照为准。
 *
 * 探测与模型探测同构：临时连接 + 临时会话，不发 prompt，用完即毁（源码
 * 结构断言保留在文末）；/api/state 把会话内存快照映射为 ready 快照。
 */

const DEVELOPER = "implementation";

const DEFINITION = { displayName: "CodeBuddy" } as AcpRuntimeDefinition;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-command-probe-"));
}

/** 延迟句柄：让测试精确控制探测 Promise 与正式会话的交错时序。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ProbeHarness = {
  registry: AgentRegistry;
  published: CommandProbeEvent[];
  /** 计数默认探测入口的调用次数，断言短路时不拉起 runtime。 */
  probeCalls: () => number;
  announce: (commands: readonly AgentCommand[], sessionId: string) => void;
  settleSession: (sessionId: string | null) => void;
};

/**
 * 真实 AgentRegistry + 可控 runtime：announce() 走 AgentSession 的正式通告
 * 路径（rememberCommands），与线上 SSE 广播同一条代码路径。
 */
function createHarness(): ProbeHarness {
  const store = new SessionStore(tmpDir());
  const eventBus = new EventBus();
  const published: CommandProbeEvent[] = [];
  let probeCalls = 0;
  let runOptions: AgentRuntimeRunOptions | null = null;
  let settleSessionId = deferred<string | null>();
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      runOptions = options;
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: Promise.resolve("ok"),
        sessionId: settleSessionId.promise,
      };
    },
  };
  const registry = new AgentRegistry(
    [{
      id: DEVELOPER,
      name: "开发",
      runtime: "codebuddy",
      cwd: process.cwd(),
      systemPrompt: "build",
    }],
    eventBus,
    store,
    "conv-probe",
    new Map([["codebuddy", runtime]]),
  );
  registry.startAll();
  return {
    registry,
    published,
    probeCalls: () => probeCalls,
    announce: (commands, sessionId) => {
      runOptions!.onSessionCommands!(commands, sessionId);
    },
    settleSession: (sessionId) => {
      settleSessionId.resolve(sessionId);
      settleSessionId = deferred<string | null>();
    },
  };
}

function commandsUpdated(events: RuntimeEvent[]): Array<Extract<RuntimeEvent, { type: "agent.commands.updated" }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: "agent.commands.updated" }> => event.type === "agent.commands.updated");
}

test("an announced snapshot short-circuits the probe without starting a runtime", async () => {
  const harness = createHarness();
  const announced: AgentCommand[] = [{ name: "init", description: "初始化项目" }];
  harness.registry.get(DEVELOPER).send("run-1", "hello");
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.announce(announced, "sess-1");
  harness.settleSession("sess-1");

  const snapshot = await probeAgentCommands(harness.registry, "ws", "conv-probe", DEVELOPER, DEFINITION, process.cwd(), {
    publish: (event) => harness.published.push(event),
    probe: () => {
      throw new Error("已有通告时不得拉起探测");
    },
    warn: () => {},
  });

  assert.equal(harness.probeCalls(), 0, "已有通告（runtime 通告或探测写回，含空列表）时不得重复拉起 runtime 进程");
  assert.deepEqual(snapshot, { status: "ready", commands: announced });
  assert.deepEqual(harness.published, [], "短路复用不需要再次广播");
});

test("a real announcement landing mid-probe wins: no probe broadcast, authoritative answer", async () => {
  const harness = createHarness();
  const probeResult = deferred<AgentCommand[]>();
  const pendingProbe = probeAgentCommands(harness.registry, "ws", "conv-probe", DEVELOPER, DEFINITION, process.cwd(), {
    publish: (event) => harness.published.push(event),
    probe: () => probeResult.promise,
    warn: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 探测在途：员工的正式会话建立并通告真实命令（与线上一致的通告路径）。
  const real: AgentCommand[] = [{ name: "review", description: "正式会话通告" }];
  harness.registry.get(DEVELOPER).send("run-1", "hello");
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.announce(real, "sess-real");
  harness.settleSession("sess-real");

  // 迟到的探测结果此刻才返回——不得广播，也不得进入权威快照。
  probeResult.resolve([{ name: "stale", description: "探测竞态的旧命令" }]);
  const snapshot = await pendingProbe;

  assert.deepEqual(harness.published, [], "正式通告先到时探测结果不得广播，UI 才不会被旧命令覆盖");
  assert.deepEqual(snapshot, { status: "ready", commands: real }, "HTTP 响应必须改答权威快照，而不是探测结果");
  assert.deepEqual(harness.registry.availableCommands()[DEVELOPER], real, "权威快照必须保持真实命令");
  assert.equal(harness.registry.hasRuntimeSessionCommands(DEVELOPER), true);
});

test("a probe failure after a real announcement must not broadcast an error snapshot", async () => {
  const harness = createHarness();
  const probeResult = deferred<AgentCommand[]>();
  const pendingProbe = probeAgentCommands(harness.registry, "ws", "conv-probe", DEVELOPER, DEFINITION, process.cwd(), {
    publish: (event) => harness.published.push(event),
    probe: () => probeResult.promise,
    warn: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const real: AgentCommand[] = [{ name: "plan", description: "正式会话通告" }];
  harness.registry.get(DEVELOPER).send("run-1", "hello");
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.announce(real, "sess-real");
  harness.settleSession("sess-real");

  probeResult.reject(new Error("runtime exited\nwith diagnostics"));
  const snapshot = await pendingProbe;

  assert.deepEqual(harness.published, [], "探测失败不得以 error 快照覆盖已到达的正式通告");
  assert.deepEqual(snapshot, { status: "ready", commands: real });
  assert.deepEqual(harness.registry.availableCommands()[DEVELOPER], real);
});

test("without a real announcement the probe result is adopted and broadcast once", async () => {
  const harness = createHarness();
  const probed: AgentCommand[] = [{ name: "review", description: "审查当前变更" }];
  const snapshot = await probeAgentCommands(harness.registry, "ws", "conv-probe", DEVELOPER, DEFINITION, process.cwd(), {
    publish: (event) => harness.published.push(event),
    probe: () => Promise.resolve(probed),
    warn: () => {},
  });

  assert.deepEqual(snapshot, { status: "ready", commands: probed });
  assert.deepEqual(harness.registry.availableCommands()[DEVELOPER], probed, "探测结果必须写回权威缓存：/api/state、探测短路和发送校验共用同一份快照");
  const published = commandsUpdated(harness.published);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]!.commands, probed);
  assert.equal(published[0]!.status, "ready");
});

test("without a real announcement a probe failure still lands an error snapshot for retry", async () => {
  const harness = createHarness();
  const snapshot = await probeAgentCommands(harness.registry, "ws", "conv-probe", DEVELOPER, DEFINITION, process.cwd(), {
    publish: (event) => harness.published.push(event),
    probe: () => Promise.reject(new Error("boom\nstack")),
    warn: () => {},
  });

  assert.deepEqual(snapshot, { status: "error", commands: [], message: "boom" });
  assert.equal(harness.registry.availableCommands()[DEVELOPER], undefined, "失败的探测不得伪造权威快照");
  const published = commandsUpdated(harness.published);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.status, "error");
  assert.equal(published[0]!.message, "boom");
});

// ---- 源码结构断言：探测实现与传输层接线的最低约束 ----

describe("slash-command probe wiring", () => {
  const runtimeSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/core/acp-runtime.ts"),
    "utf-8",
  );
  const serverSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server/index.ts"),
    "utf-8",
  );
  const probeModule = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server/command-probe.ts"),
    "utf-8",
  );

  test("probeAcpCommands never prompts and destroys the temporary connection", () => {
    const probe = runtimeSource.match(/export async function probeAcpCommands\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(probe, "probeAcpCommands must exist in acp-runtime.ts");
    assert.ok(probe.includes("available_commands_update"), "the probe must collect command announcements");
    assert.ok(probe.includes("newSession"), "the probe must establish a temporary session");
    assert.ok(!probe.includes("connection.prompt"), "the probe must not prompt the runtime");
    assert.ok(probe.includes("connection?.destroy?.()"), "the temporary connection must be destroyed");
  });

  test("the probe-commands route validates the target and dedupes concurrent probes", () => {
    const route = serverSource.match(
      /if \(req\.method === "POST" && url\.pathname === "\/api\/agents\/probe-commands"\) \{[\s\S]*?\n    \}/,
    )?.[0] ?? "";
    assert.ok(route, "the probe-commands route must exist in server/index.ts");
    assert.ok(route.includes("resolveTarget(url)"), "the route must resolve the page target");
    assert.ok(route.includes("configStore.load"), "the target employee must be validated against workspace configs");
    assert.ok(route.includes("commandProbeInFlight"), "concurrent probes for the same employee must share one promise");
    assert.ok(route.includes("probeAgentCommands("), "the route must delegate to the shared probe helper");
  });

  test("the probe module broadcasts only what the authoritative snapshot allows", () => {
    const writeBack = probeModule.indexOf("target?.adoptProbedCommands(agentId, commands)");
    assert.ok(writeBack > -1, "探测结果必须写回权威缓存");
    const broadcast = probeModule.indexOf("deps.publish(");
    const refusal = probeModule.indexOf("?? true))");
    assert.ok(refusal > writeBack, "写回必须先于（并决定）广播");
    assert.ok(broadcast > refusal, "写回被拒（正式通告先到）时不得走到广播");
    const catchBody = probeModule.slice(probeModule.indexOf("} catch (error) {"));
    assert.ok(
      catchBody.indexOf("hasRuntimeSessionCommands(agentId)") > -1
        && catchBody.indexOf("deps.publish(") > catchBody.indexOf("hasRuntimeSessionCommands(agentId)"),
      "探测失败也要先核对正式通告，再决定是否广播 error",
    );
  });

  test("the state payload maps in-memory commands to ready snapshots", () => {
    assert.ok(
      serverSource.includes("satisfies AgentCommandsSnapshot"),
      "/api/state 必须把命令列表映射为共享快照类型",
    );
    const stateMapping = serverSource.match(/agentCommands: ctx\s*\?[\s\S]*?\}\s*,\s*\n {6}\}: \{\},/)?.[0]
      ?? serverSource.match(/agentCommands: ctx[\s\S]*?satisfies AgentCommandsSnapshot/)?.[0] ?? "";
    assert.ok(
      stateMapping.includes("ctx.availableCommands()"),
      "/api/state 必须直接读权威快照（ctx.availableCommands），不得伪造从未通告员工的 ready 空列表",
    );
  });
});
