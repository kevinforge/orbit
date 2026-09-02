import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { AgentRegistry } from "../src/core/agent-registry.ts";
import type { AgentRuntime } from "../src/core/agent-runtime.ts";
import { createDefaultAgentProfiles } from "../src/core/agent-profiles.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { MessageStore } from "../src/core/message-store.ts";
import { resolveSlashSendTarget } from "../src/core/native-commands.ts";
import { RunManager } from "../src/core/run-manager.ts";
import { SessionStore } from "../src/core/session-store.ts";
import type { AgentCommand, ChatMessage } from "../src/shared/types.ts";

/**
 * 斜杠命令的闭环（issue #160 收尾 review 要求）：
 * 探测写回 → 发送推导读到同一份权威快照 → RunManager 下发推导出的命令文本。
 *
 * 服务端三处读取共用 AgentSession 内的快照：
 * - /api/state：registry.availableCommands()（未通告员工缺 key，前端据此主动探测）；
 * - 探测短路：probeAgentCommands 先查同一份快照，成功后 adoptProbedCommands 写回；
 * - 发送推导：handlePostMessage 调用共享的 resolveSlashSendTarget，从消息原文 +
 *   交互模式 + @员工: 前缀 + 权威命令快照推导投递目标与命令文本，再
 *   enqueueNativeCommand 下发。
 * 这里在真实 Registry + RunManager 上按服务端相同步骤组合一次完整闭环。
 */

const DEVELOPER = "implementation";

function createSourceMessage(content: string): ChatMessage {
  return {
    id: "msg_source",
    kind: "user",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "sent",
  };
}

test("probe write-back feeds the send whitelist and the runtime receives the raw command", async () => {
  const prompts: string[] = [];
  let buildPromptCalls = 0;
  const runtime: AgentRuntime = {
    kind: "codebuddy",
    run(options) {
      prompts.push(options.prompt);
      return {
        process: { kill() {}, pid: 12345, interrupt() {} },
        result: Promise.resolve("done"),
        sessionId: Promise.resolve(`${options.agentId}-sess-1`),
      };
    },
  };
  const registry = new AgentRegistry(
    createDefaultAgentProfiles(process.cwd()),
    new EventBus(),
    new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), "orbit-commands-loop-"))),
    "conv-closed-loop",
    new Map([
      ["claude-code", runtime],
      ["codex", runtime],
      ["codebuddy", runtime],
    ]),
  );
  registry.startAll();

  // 1) 冷启动：正式会话从未通告，快照里必须缺 key 而不是伪造 ready 空列表，
  //    否则前端看到 ready + [] 就不再主动探测，菜单永远空白。
  assert.ok(
    !(DEVELOPER in registry.availableCommands()),
    "未通告的员工必须在权威快照里缺 key，前端据此在菜单打开时主动探测",
  );

  // 2) 探测写回：与服务端 probeAgentCommands 成功路径的 adoptProbedCommands 同一步。
  const probed: AgentCommand[] = [
    { name: "review", description: "审查当前变更" },
    { name: "init", description: "初始化项目" },
  ];
  assert.equal(registry.adoptProbedCommands(DEVELOPER, probed), true);

  // 3) 发送推导：调用服务端 handlePostMessage 使用的同一个 resolveSlashSendTarget，
  //    从消息原文推导目标与命令文本——不再复刻服务端白名单表达式。
  const content = "@蔡一平: /review 聚焦登录流程";
  const delivery = resolveSlashSendTarget(
    content,
    "direct",
    DEVELOPER,
    registry.states().map((state) => ({ id: state.id, label: state.label })),
    registry.availableCommands(),
  );
  assert.ok(delivery, "探测写回的命令必须能通过发送推导，否则补全可见却发送被拒");
  assert.equal(delivery!.agentId, DEVELOPER, "前缀命中必须直达该员工");
  assert.equal(
    delivery!.commandText,
    "/review 聚焦登录流程",
    "投递文本必须剥离 @员工: 前缀，与频道历史同源不分叉",
  );

  // 4) 投递：RunManager 原生命令通道下发推导出的命令文本，不经过 buildPrompt 组装。
  const manager = new RunManager({
    conversationId: "conv-closed-loop",
    messages: new MessageStore(),
    eventBus: new EventBus(),
    agents: {
      get(agentId) {
        return registry.get(agentId);
      },
    },
    buildPrompt() {
      buildPromptCalls += 1;
      return `context+${delivery!.commandText}`;
    },
    onRunCompleted() {},
  });
  manager.enqueueNativeCommand(delivery!.agentId, delivery!.commandText, createSourceMessage(content));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(prompts, ["/review 聚焦登录流程"], "runtime 必须收到从原文推导、未经改写的命令文本");
  assert.equal(buildPromptCalls, 0, "原生命令不得经过 buildPrompt 的上下文组装");
});

describe("server wiring stays on the authoritative snapshot", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const serverSource = fs.readFileSync(path.join(repoRoot, "src/server/index.ts"), "utf-8");
  const registrySource = fs.readFileSync(path.join(repoRoot, "src/core/agent-registry.ts"), "utf-8");

  test("send derivation reads the shared snapshot and delivery bypasses routing", () => {
    assert.ok(
      serverSource.includes("const delivery = resolveSlashSendTarget(")
        && serverSource.includes("context.availableCommands(),"),
      "发送推导必须走共享的 resolveSlashSendTarget 并读权威快照：探测写回的命令才能直接发送",
    );
    assert.ok(
      serverSource.includes("context.runManager.enqueueNativeCommand(delivery.agentId, delivery.commandText, userMessage)"),
      "命令投递必须进入 RunManager 的原生命令通道，下发从原文推导出的命令文本",
    );
  });

  test("the registry snapshot only contains announced employees", () => {
    assert.ok(
      registrySource.includes("session?.commandsAnnounced()"),
      "/api/state 的口径必须来自 registry：未通告（runtime 未通告且无探测写回）的员工缺 key",
    );
    assert.ok(
      registrySource.includes("adoptProbedCommands(agentId: AgentId"),
      "registry 必须暴露探测写回入口，供服务端探测路径把结果并入权威快照",
    );
  });
});
