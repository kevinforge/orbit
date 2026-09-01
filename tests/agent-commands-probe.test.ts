import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * 斜杠命令主动探测的服务端约束（issue #160 收尾）。
 *
 * ACP 没有独立的“命令列表”请求，命令由 runtime 会话建立时推送；此前输入 “/”
 * 只有先发过一次普通消息才有数据，UI 表现为毫无反应。按
 * tests/message-native-command.test.ts 的源码结构断言手法覆盖：
 * - 探测与模型探测同构：临时连接 + 临时会话，不发 prompt，用完即毁；
 * - 路由校验目标并按会话+员工去重并发探测，避免重复拉起 runtime 进程；
 * - 会话里已有通告（runtime 通告或探测写回，含空列表）直接复用；探测成功
 *   写回权威缓存后广播，失败同样以 error 快照广播，UI 可重试；
 * - /api/state 把会话内存快照映射为 ready 快照供页面初始化。
 */

const serverSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/server/index.ts"),
  "utf-8",
);

const runtimeSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/core/acp-runtime.ts"),
  "utf-8",
);

describe("slash-command probe wiring", () => {
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
    assert.ok(route.includes('configStore.load'), "the target employee must be validated against workspace configs");
    assert.ok(route.includes("commandProbeInFlight"), "concurrent probes for the same employee must share one promise");
    assert.ok(route.includes("probeAgentCommands("), "the route must delegate to the shared probe helper");
  });

  test("an announced snapshot short-circuits the probe, and probe results write back before broadcasting", () => {
    const helper = serverSource.match(/async function probeAgentCommands\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(helper, "probeAgentCommands must exist in server/index.ts");
    assert.ok(
      helper.includes("const existing = ctx?.availableCommands()[agentId];") && helper.includes("if (existing) {"),
      "已有通告（runtime 通告或探测写回，含空列表）时不得重复拉起 runtime 进程",
    );
    const writeBack = helper.indexOf("ctx?.adoptProbedCommands(agentId, commands)");
    assert.ok(writeBack > -1, "探测结果必须写回权威缓存：/api/state、探测短路和发送校验共用同一份快照");
    assert.ok(
      writeBack < helper.indexOf('type: "agent.commands.updated"'),
      "写回必须发生在广播之前：广播只通知已打开页面，权威状态在写回时已就位",
    );
    assert.ok(helper.includes('type: "agent.commands.updated"'), "探测结果必须按会话广播");
    assert.ok(helper.includes('status: "error"'), "失败也要以 error 快照广播，UI 才能停在可重试的失败态");
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
