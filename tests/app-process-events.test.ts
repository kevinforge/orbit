import test from "node:test";
import assert from "node:assert/strict";

import { applyEvent, buildProcessTimeline, mergeModelProbeResponse, mergeProbedConfigs, upsertMessage } from "../src/ui/App.tsx";
import type { AgentActivityEvent, AgentCommand, AgentModelStateSnapshot, AgentPlanSnapshot, AppState, ChatMessage } from "../src/shared/types.ts";

const CONVERSATION = "conv1";

function agentMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg_000001",
    kind: "agent",
    agentId: "implementation",
    content: "正在处理…",
    createdAt: "2026-01-01T00:00:01.000Z",
    runId: "run-1",
    ...overrides,
  };
}

function state(messages: ChatMessage[]): AppState {
  return {
    workspace: { id: "ws1", name: "Workspace", path: "D:/project" },
    conversation: { id: CONVERSATION, name: CONVERSATION },
    messages,
    messageHistory: { hasOlderMessages: false, olderCursor: null },
    agents: [], terminal: {}, runningSummaries: [], runtimeAvailability: [], pendingPermissions: [], pendingElicitations: [],
    agentModelStates: {}, agentCommands: {},
  };
}

function runActivity(activity: AgentActivityEvent) {
  return { type: "run.activity" as const, conversationId: CONVERSATION, agentId: "implementation", runId: "run-1", activity };
}

const planA: AgentPlanSnapshot = { format: "items", entries: [{ content: "检查仓库", priority: "high", status: "completed" }] };
const planB: AgentPlanSnapshot = { format: "items", entries: [
  { content: "检查仓库", priority: "high", status: "completed" },
  { content: "实现修改", priority: "high", status: "in_progress" },
] };

test("process.text deltas append in order and snapshots replace wholesale", () => {
  const first = applyEvent(state([agentMessage()]), runActivity({ type: "process.text", text: "先检查", timestamp: "2026-01-01T00:00:02.000Z" }));
  const second = applyEvent(first, runActivity({ type: "process.text", text: "构建。", timestamp: "2026-01-01T00:00:03.000Z" }));
  assert.equal(second.messages[0]?.activity?.filter((item) => item.type === "process.text").map((item) => item.text).join(""), "先检查构建。");

  // 流式期间最终回复文本也以增量进入过程区；结算快照整体替换，剔除最终正文。
  const third = applyEvent(second, runActivity({ type: "process.text", text: "最终答案", timestamp: "2026-01-01T00:00:04.000Z" }));
  assert.equal(third.messages[0]?.activity?.filter((item) => item.type === "process.text").map((item) => item.text).join(""), "先检查构建。最终答案");
  const settled = applyEvent(third, runActivity({ type: "process.text", text: "先检查构建。", snapshot: true, timestamp: "2026-01-01T00:00:05.000Z" }));
  assert.equal(settled.messages[0]?.activity?.filter((item) => item.type === "process.text").map((item) => item.text).join(""), "先检查构建。");

  const finalOnly = applyEvent(
    state([agentMessage({ activity: [{ type: "process.text", text: "最终答案", timestamp: "2026-01-01T00:00:05.000Z" }] })]),
    runActivity({ type: "process.text", text: "", snapshot: true, timestamp: "2026-01-01T00:00:06.000Z" }),
  );
  assert.equal(finalOnly.messages[0]?.activity?.some((item) => item.type === "process.text"), false);
});

test("plan updates replace the snapshot in place without accumulating duplicates", () => {
  const first = applyEvent(state([agentMessage()]), runActivity({ type: "plan.updated", plan: planA, timestamp: "2026-01-01T00:00:02.000Z" }));
  assert.deepEqual(first.messages[0]?.plan, planA);
  const second = applyEvent(first, runActivity({ type: "plan.updated", plan: planB, timestamp: "2026-01-01T00:00:03.000Z" }));
  assert.deepEqual(second.messages[0]?.plan, planB);
  // Plan 始终是单份快照字段，不会进入 activity 数组。
  assert.equal(second.messages[0]?.activity, undefined);

  const removed = applyEvent(second, runActivity({ type: "plan.removed", planId: "", timestamp: "2026-01-01T00:00:04.000Z" }));
  assert.equal(removed.messages[0]?.plan, undefined);
});

test("tool and status activity accumulate as live-only events", () => {
  const first = applyEvent(state([agentMessage()]), runActivity({ type: "tool.started", name: "Read", input: "package.json", timestamp: "2026-01-01T00:00:02.000Z" }));
  const second = applyEvent(first, runActivity({ type: "tool.completed", name: "Read", summary: "done", timestamp: "2026-01-01T00:00:03.000Z" }));
  assert.deepEqual(second.messages[0]?.activity?.map((item) => item.type), ["tool.started", "tool.completed"]);
  // 其他运行的消息不受影响。
  const other = second.messages.map((message) => ({ ...message, runId: "run-2" }));
  const untouched = applyEvent(state(other), runActivity({ type: "status", text: "等待审批", timestamp: "2026-01-01T00:00:04.000Z" }));
  assert.equal(untouched.messages[0]?.activity?.length, 2);
});

test("message.updated payloads from the store preserve live-only client fields", () => {
  const live = applyEvent(
    applyEvent(
      state([agentMessage()]),
      runActivity({ type: "process.text", text: "过程叙述", timestamp: "2026-01-01T00:00:02.000Z" }),
    ),
    runActivity({ type: "tool.started", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" }),
  );
  const planApplied = applyEvent(live, runActivity({ type: "plan.updated", plan: planA, timestamp: "2026-01-01T00:00:04.000Z" }));
  const liveWithAnswer = applyEvent(planApplied, runActivity({
    type: "process.text",
    text: "最终回复",
    stream: "answer",
    answerGroup: "final-1",
    timestamp: "2026-01-01T00:00:05.000Z",
  }));

  // 存储侧 message.updated 只带状态字段，未携带的实时字段必须保留，过程区不能被清空。
  const updated = upsertMessage(liveWithAnswer, {
    ...agentMessage({ status: "running", runStatus: "running", processTimeline: undefined, plan: undefined, activity: undefined }),
  });
  assert.equal(updated.messages[0]?.plan, planA);
  assert.equal(updated.messages[0]?.activity?.length, 3);

  const compactTimeline = [
    { type: "text" as const, text: "过程叙述" },
    { type: "tools" as const, count: 1, failedCount: 0 },
  ];
  // 结算后的 message.updated 带轻量时间线与 Plan，正常覆盖；终态事件按
  // 结算快照显式标记的分组剔除最终回答分片。
  const settled = applyEvent(updated, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "done", runStatus: "completed", content: "最终回复", processTimeline: compactTimeline, plan: planB }),
    settleTransientActivity: true,
    excludedAnswerGroup: "final-1",
  });
  assert.deepEqual(settled.messages[0]?.processTimeline, compactTimeline);
  assert.deepEqual(settled.messages[0]?.plan, planB);
  // 即使客户端漏收剔除最终回答的结算快照，终态事件也会按显式分组剔除最终回答分片，
  // 但保留当前页面的过程文本和完整工具明细；刷新后才使用持久化摘要。
  assert.deepEqual(settled.messages[0]?.activity?.map((item) => item.type), ["process.text", "tool.started"]);
  assert.deepEqual(
    buildProcessTimeline(settled.messages[0]?.activity, settled.messages[0]?.processTimeline),
    [
      { kind: "text", text: "过程叙述", timestamp: "2026-01-01T00:00:02.000Z", stream: "progress" },
      { kind: "tools", activities: [{ type: "tool.started", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" }] },
    ],
  );
  const refreshed = { ...settled, messages: settled.messages.map((message) => ({ ...message, activity: undefined })) };
  assert.deepEqual(
    buildProcessTimeline(refreshed.messages[0]?.activity, refreshed.messages[0]?.processTimeline),
    [
      { kind: "text", text: "过程叙述", timestamp: "", stream: "progress" },
      { kind: "tool-summary", count: 1, failedCount: 0 },
    ],
  );

  // 结算载荷用 null 明确清除字段；即使客户端错过了 plan.removed 事件，
  // 最终 message.updated 也不能保留过期的实时状态。
  const cleared = applyEvent(updated, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "done", runStatus: "completed", content: "最终回复", processTimeline: null, plan: null }),
    settleTransientActivity: true,
    excludedAnswerGroup: "final-1",
  });
  assert.equal(cleared.messages[0]?.processTimeline, null);
  assert.equal(cleared.messages[0]?.plan, null);
  assert.equal(cleared.messages[0]?.activity?.length, 2);

  // 终态事件未携带分组标识（失败/中断/取消）时，不能剔除任何部分回答文本。
  const keptPartial = applyEvent(updated, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "error", runStatus: "failed", content: "运行失败", processTimeline: null, plan: null }),
    settleTransientActivity: true,
  });
  assert.equal(keptPartial.messages[0]?.activity?.length, 3, "missing excludedAnswerGroup must keep partial answer activity");
});

test("process timeline interleaves narration and consecutive tool groups", () => {
  const events: AgentActivityEvent[] = [
    { type: "process.text", text: "先检查。", stream: "progress", answerGroup: "", timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "tool.started", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "tool.completed", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" },
    { type: "tool.started", toolCallId: "tool-2", name: "Search", timestamp: "2026-01-01T00:00:04.000Z" },
    { type: "process.text", text: "发现问题。", stream: "answer", answerGroup: "response-1", timestamp: "2026-01-01T00:00:05.000Z" },
    { type: "tool.started", toolCallId: "tool-3", name: "Edit", timestamp: "2026-01-01T00:00:06.000Z" },
    { type: "process.text", text: "最终正文", stream: "answer", answerGroup: "response-2", timestamp: "2026-01-01T00:00:07.000Z" },
  ];
  const live = events.reduce(
    (current, activity) => applyEvent(current, runActivity(activity)),
    state([agentMessage()]),
  );
  const settled = applyEvent(live, runActivity({
    type: "process.text",
    text: "先检查。发现问题。",
    snapshot: true,
    excludedAnswerGroup: "response-2",
    timestamp: "2026-01-01T00:00:08.000Z",
  }));

  const timeline = buildProcessTimeline(settled.messages[0]?.activity);
  assert.deepEqual(timeline.map((entry) => entry.kind), ["text", "tools", "text", "tools"]);
  assert.equal(timeline[0]?.kind === "text" && timeline[0].text, "先检查。");
  assert.equal(timeline[1]?.kind === "tools" && timeline[1].activities.length, 3);
  assert.equal(timeline[2]?.kind === "text" && timeline[2].text, "发现问题。");
  assert.equal(timeline.some((entry) => entry.kind === "text" && entry.text.includes("最终正文")), false);
});

test("answer text stays in the live process timeline across later tool calls", () => {
  // Issue #139：运行期间回答正文不提升到正文区，也不因后续工具调用被隐藏或降级。
  // 到达顺序 text → tools → text 始终保留在过程时间线。
  const events: AgentActivityEvent[] = [
    { type: "process.text", text: "先给出判断", stream: "answer", answerGroup: "response-1", timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "tool.started", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "tool.completed", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" },
    { type: "process.text", text: "最终", stream: "answer", answerGroup: "response-2", timestamp: "2026-01-01T00:00:04.000Z" },
    { type: "process.text", text: "正文", stream: "answer", answerGroup: "response-2", timestamp: "2026-01-01T00:00:05.000Z" },
  ];
  const live = events.reduce(
    (current, activity) => applyEvent(current, runActivity(activity)),
    state([agentMessage()]),
  );

  // 正文仍是占位符：run.activity 只增长 activity，不改写消息内容。
  assert.equal(live.messages[0]?.content, "正在处理…");
  const timeline = buildProcessTimeline(live.messages[0]?.activity);
  assert.deepEqual(timeline.map((entry) => entry.kind), ["text", "tools", "text"]);
  // 相邻同 stream 分片合并；后到的回答分组不被隐藏，也不与前一段回答合并。
  assert.deepEqual(timeline[0], { kind: "text", text: "先给出判断", timestamp: "2026-01-01T00:00:01.000Z", stream: "answer" });
  assert.deepEqual(timeline[2], { kind: "text", text: "最终正文", timestamp: "2026-01-01T00:00:04.000Z", stream: "answer" });

  // 相邻不同 stream 的文本不合并：过程叙述与回答正文保持独立文本块。
  const mixed: AgentActivityEvent[] = [
    { type: "process.text", text: "检查中。", stream: "progress", answerGroup: "", timestamp: "2026-01-01T00:00:06.000Z" },
    { type: "process.text", text: "回答开始", stream: "answer", answerGroup: "response-3", timestamp: "2026-01-01T00:00:07.000Z" },
  ];
  assert.deepEqual(
    buildProcessTimeline(mixed).map((entry) => (entry.kind === "text" ? { text: entry.text, stream: entry.stream } : entry.kind)),
    [
      { text: "检查中。", stream: "progress" },
      { text: "回答开始", stream: "answer" },
    ],
  );

  // 结算事件按显式分组只剔除指定分组：response-2 移除，response-1 保留在过程区。
  const settled = applyEvent(live, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "done", runStatus: "completed", content: "最终正文", processTimeline: null, plan: null }),
    settleTransientActivity: true,
    excludedAnswerGroup: "response-2",
  });
  const settledTimeline = buildProcessTimeline(settled.messages[0]?.activity);
  assert.deepEqual(settledTimeline.map((entry) => entry.kind), ["text", "tools"]);
  assert.equal(settledTimeline[0]?.kind === "text" && settledTimeline[0].text, "先给出判断");
});

test("terminal message update settles body, status, and process cleanup in one step", () => {
  // 结算二次渲染修复：生产链路不再把结算快照推给前端，前端在收到终态
  // message.updated 之前正文保持占位、最终回答留在过程 activity；终态事件
  // 到达时一次完成正文替换、状态切换、分组剔除与持久化时间线覆盖。
  const events: AgentActivityEvent[] = [
    { type: "process.text", text: "先检查。", stream: "progress", answerGroup: "", timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "tool.started", toolCallId: "tool-1", name: "Read", input: "package.json", timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "tool.completed", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" },
    { type: "process.text", text: "最终", stream: "answer", answerGroup: "response-9", timestamp: "2026-01-01T00:00:04.000Z" },
    { type: "process.text", text: "回复", stream: "answer", answerGroup: "response-9", timestamp: "2026-01-01T00:00:05.000Z" },
  ];
  const live = events.reduce(
    (current, activity) => applyEvent(current, runActivity(activity)),
    state([agentMessage({ status: "running", runStatus: "running" })]),
  );

  // 只有普通 run.activity：正文仍是占位符，最终回答完整保留在过程区。
  assert.equal(live.messages[0]?.content, "正在处理…");
  assert.equal(live.messages[0]?.status, "running");
  assert.equal(live.messages[0]?.activity?.length, 5);
  assert.equal(
    live.messages[0]?.activity?.filter((item) => item.type === "process.text").map((item) => item.type === "process.text" ? item.text : "").join(""),
    "先检查。最终回复",
  );

  // 终态事件一次完成：正文替换 + 状态切换 + answer 分组剔除 + 时间线覆盖。
  const compactTimeline = [
    { type: "text" as const, text: "先检查。" },
    { type: "tools" as const, count: 1, failedCount: 0 },
  ];
  const settled = applyEvent(live, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "done", runStatus: "completed", content: "最终回复", processTimeline: compactTimeline }),
    settleTransientActivity: true,
    excludedAnswerGroup: "response-9",
  });
  assert.equal(settled.messages[0]?.content, "最终回复");
  assert.equal(settled.messages[0]?.status, "done");
  assert.deepEqual(settled.messages[0]?.processTimeline, compactTimeline);
  // 最终回答分片被剔除，过程叙述与工具明细保留。
  assert.deepEqual(settled.messages[0]?.activity?.map((item) => item.type), ["process.text", "tool.started", "tool.completed"]);
  assert.deepEqual(
    buildProcessTimeline(settled.messages[0]?.activity, settled.messages[0]?.processTimeline)[0],
    { kind: "text", text: "先检查。", timestamp: "2026-01-01T00:00:01.000Z", stream: "progress" },
  );
});

test("persisted process timeline restores narration and compact tool groups in order", () => {
  const timeline = buildProcessTimeline(undefined, [
    { type: "text", text: "先检查。" },
    { type: "tools", count: 5, failedCount: 1 },
    { type: "text", text: "继续验证。" },
    { type: "tools", count: 3, failedCount: 0 },
  ]);
  assert.deepEqual(timeline.map((entry) => entry.kind), ["text", "tool-summary", "text", "tool-summary"]);
  assert.deepEqual(timeline[1], { kind: "tool-summary", count: 5, failedCount: 1 });
  assert.deepEqual(timeline[3], { kind: "tool-summary", count: 3, failedCount: 0 });
});

test("final answer groups stay out of the expanded process view", () => {
  const activity: AgentActivityEvent[] = [
    { type: "process.text", text: "过程说明", timestamp: "2026-01-01T00:00:00.000Z", stream: "progress" as const },
    { type: "process.text", text: "最终回答", timestamp: "2026-01-01T00:00:01.000Z", stream: "answer" as const, isFinal: true, answerGroup: "response-1" },
  ];
  const timeline = buildProcessTimeline(activity);
  const hidden = buildProcessTimeline(activity, undefined, { hideFinalAnswer: true });

  assert.deepEqual(timeline.map((entry) => entry.kind), ["text", "text"]);
  assert.deepEqual(hidden, [{ kind: "text", text: "过程说明", timestamp: "2026-01-01T00:00:00.000Z", stream: "progress" }]);
});

test("run.activity events from other conversations are ignored", () => {
  const initial = state([agentMessage()]);
  const result = applyEvent(initial, {
    type: "run.activity",
    conversationId: "conv2",
    agentId: "implementation",
    runId: "run-1",
    activity: { type: "process.text", text: "其他会话", timestamp: "2026-01-01T00:00:02.000Z" },
  });
  assert.equal(result.messages[0]?.activity, undefined);
});

// ---- issue #142：模型快照事件进入 UI 状态 ----

test("agent.model_state snapshots are stored per agent without conversation gating", () => {
  const initial = state([agentMessage()]);
  const snapshot: AgentModelStateSnapshot = {
    agentId: "implementation",
    runtimeKind: "claude-code",
    configId: "model",
    choices: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
    currentValue: "sonnet",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  // agent.model_state 无 conversationId：即使当前会话不是产生快照的会话也要更新。
  const updated = applyEvent({ ...initial, conversation: { id: "other", name: "other" } }, {
    type: "agent.model_state",
    workspaceId: "ws1",
    agentId: "implementation",
    modelState: snapshot,
  });
  assert.deepEqual(updated.agentModelStates.implementation, snapshot);

  const newer = { ...snapshot, currentValue: "opus", updatedAt: "2026-01-01T00:00:05.000Z" };
  const replaced = applyEvent(updated, {
    type: "agent.model_state",
    workspaceId: "ws1",
    agentId: "reviewer",
    modelState: newer,
  });
  assert.equal(replaced.agentModelStates.implementation, snapshot, "其他员工的快照不受影响");
  assert.equal(replaced.agentModelStates.reviewer.currentValue, "opus");

  const otherWorkspace = applyEvent(replaced, {
    type: "agent.model_state",
    workspaceId: "ws2",
    agentId: "implementation",
    modelState: { ...snapshot, currentValue: "opus" },
  });
  assert.equal(otherWorkspace.agentModelStates.implementation, snapshot, "其他工作区的快照不得覆盖当前状态");
});

// ---- issue #160：斜杠命令快照事件进入 UI 状态 ----

test("agent.commands.updated snapshots are stored per agent and gated by page scope", () => {
  const commands: AgentCommand[] = [
    { name: "init", description: "初始化项目" },
    { name: "review", description: "审查当前变更", inputHint: "可选关注点" },
  ];
  // 运行期通告帧不带 status：默认落为 ready 快照。
  const updated = applyEvent(state([agentMessage()]), {
    type: "agent.commands.updated",
    workspaceId: "ws1",
    conversationId: CONVERSATION,
    agentId: "implementation",
    commands,
  });
  assert.deepEqual(updated.agentCommands.implementation, { status: "ready", commands });

  // 空通告同样生效：替换会话后的清空必须到达页面。
  const cleared = applyEvent(updated, {
    type: "agent.commands.updated",
    workspaceId: "ws1",
    conversationId: CONVERSATION,
    agentId: "implementation",
    commands: [],
  });
  assert.deepEqual(cleared.agentCommands.implementation, { status: "ready", commands: [] });

  // 其他会话/其他工作区的同名员工不得覆盖当前页面。
  const otherConversation = applyEvent(updated, {
    type: "agent.commands.updated",
    workspaceId: "ws1",
    conversationId: "conv2",
    agentId: "implementation",
    commands: [],
  });
  assert.deepEqual(otherConversation.agentCommands.implementation, { status: "ready", commands }, "其他会话的清空不得影响当前页面");
  const otherWorkspace = applyEvent(updated, {
    type: "agent.commands.updated",
    workspaceId: "ws2",
    conversationId: CONVERSATION,
    agentId: "implementation",
    commands: [],
  });
  assert.deepEqual(otherWorkspace.agentCommands.implementation, { status: "ready", commands }, "其他工作区的清空不得影响当前页面");
});

test("agent.commands.updated carries probe failure as an error snapshot", () => {
  // 主动探测失败（issue #160 收尾）：error 快照携带原因，UI 据此展示失败与重试，
  // 不再与“尚未获取”“没有命令”混为一谈。
  const failed = applyEvent(state([agentMessage()]), {
    type: "agent.commands.updated",
    workspaceId: "ws1",
    conversationId: CONVERSATION,
    agentId: "implementation",
    commands: [],
    status: "error",
    message: "claude-code slash-command discovery timed out.",
  });
  assert.deepEqual(failed.agentCommands.implementation, {
    status: "error",
    commands: [],
    message: "claude-code slash-command discovery timed out.",
  });

  // 后续就绪通告整体替换失败快照。
  const recovered = applyEvent(failed, {
    type: "agent.commands.updated",
    workspaceId: "ws1",
    conversationId: CONVERSATION,
    agentId: "implementation",
    commands: [{ name: "init", description: "初始化项目" }],
  });
  assert.deepEqual(recovered.agentCommands.implementation, {
    status: "ready",
    commands: [{ name: "init", description: "初始化项目" }],
  });
});

test("model probe responses preserve unsaved local employee configuration", () => {
  const local = {
    id: "developer",
    name: "本地改名",
    description: "未保存描述",
    runtime: "codex" as const,
    systemPrompt: "未保存提示词",
    enabled: true,
    model: { runtimeKind: "codex" as const, preferredModelId: "model-b" },
    modelState: undefined,
  };
  const probed = {
    ...local,
    name: "服务端旧名称",
    description: "服务端旧描述",
    systemPrompt: "服务端旧提示词",
    model: undefined,
    modelState: {
      agentId: "developer",
      runtimeKind: "codex" as const,
      configId: "model",
      choices: [{ value: "model-a", name: "模型 A" }],
      currentValue: undefined,
      currentValueSource: "probe" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    modelProbe: { runtimeKind: "codex" as const, status: "ready" as const },
  };

  const merged = mergeProbedConfigs([local], [probed]);
  assert.equal(merged[0]?.name, "本地改名");
  assert.equal(merged[0]?.systemPrompt, "未保存提示词");
  assert.equal(merged[0]?.model?.preferredModelId, "model-b");
  assert.deepEqual(merged[0]?.modelState, probed.modelState);
  assert.deepEqual(merged[0]?.modelProbe, probed.modelProbe);
});

test("targeted model probe applies to an unsaved runtime switch", () => {
  const local = {
    id: "developer",
    name: "本地改名",
    description: "未保存描述",
    runtime: "codebuddy" as const,
    systemPrompt: "未保存提示词",
    enabled: true,
  };
  const serverConfig = {
    ...local,
    name: "服务端旧名称",
    runtime: "claude-code" as const,
  };
  const modelState: AgentModelStateSnapshot = {
    agentId: "developer",
    runtimeKind: "codebuddy",
    configId: "model",
    choices: [{ value: "glm-5.3", name: "GLM-5.3" }],
    currentValue: undefined,
    currentValueSource: "probe",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const merged = mergeModelProbeResponse([local], {
    configs: [serverConfig],
    target: {
      agentId: "developer",
      runtimeKind: "codebuddy",
      modelState,
      modelProbe: { runtimeKind: "codebuddy", status: "ready", updatedAt: modelState.updatedAt },
    },
  });

  assert.equal(merged[0]?.name, "本地改名");
  assert.equal(merged[0]?.runtime, "codebuddy");
  assert.equal(merged[0]?.systemPrompt, "未保存提示词");
  assert.deepEqual(merged[0]?.modelState, modelState);
  assert.equal(merged[0]?.modelProbe?.status, "ready");
});

test("targeted model probe does not overwrite a later runtime switch", () => {
  const local = {
    id: "developer",
    name: "开发",
    runtime: "codex" as const,
    systemPrompt: "实现任务",
    enabled: true,
  };
  const merged = mergeModelProbeResponse([local], {
    configs: [local],
    target: {
      agentId: "developer",
      runtimeKind: "codebuddy",
      modelState: {
        agentId: "developer",
        runtimeKind: "codebuddy",
        configId: "model",
        choices: [{ value: "glm-5.3", name: "GLM-5.3" }],
        currentValue: undefined,
        currentValueSource: "probe",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      modelProbe: { runtimeKind: "codebuddy", status: "ready" },
    },
  });

  assert.equal(merged[0]?.runtime, "codex");
  assert.equal(merged[0]?.modelState, undefined);
});
