import test from "node:test";
import assert from "node:assert/strict";

import { applyEvent, buildProcessTimeline, resolveLiveResponseText, upsertMessage } from "../src/ui/App.tsx";
import type { AgentActivityEvent, AgentPlanSnapshot, AppState, ChatMessage } from "../src/shared/types.ts";

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
  // 结算后的 message.updated 带轻量时间线与 Plan，正常覆盖。
  const settled = applyEvent(updated, {
    type: "message.updated",
    conversationId: CONVERSATION,
    message: agentMessage({ status: "done", runStatus: "completed", content: "最终回复", processTimeline: compactTimeline, plan: planB }),
    settleTransientActivity: true,
  });
  assert.deepEqual(settled.messages[0]?.processTimeline, compactTimeline);
  assert.deepEqual(settled.messages[0]?.plan, planB);
  // 即使客户端漏收剔除最终回答的结算快照，终态事件也会剔除最终回答分片，
  // 但保留当前页面的过程文本和完整工具明细；刷新后才使用持久化摘要。
  assert.deepEqual(settled.messages[0]?.activity?.map((item) => item.type), ["process.text", "tool.started"]);
  assert.deepEqual(
    buildProcessTimeline(settled.messages[0]?.activity, null, settled.messages[0]?.processTimeline),
    [
      { kind: "text", text: "过程叙述", timestamp: "2026-01-01T00:00:02.000Z" },
      { kind: "tools", activities: [{ type: "tool.started", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" }] },
    ],
  );
  const refreshed = { ...settled, messages: settled.messages.map((message) => ({ ...message, activity: undefined })) };
  assert.deepEqual(
    buildProcessTimeline(refreshed.messages[0]?.activity, null, refreshed.messages[0]?.processTimeline),
    [
      { kind: "text", text: "过程叙述", timestamp: "" },
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
  });
  assert.equal(cleared.messages[0]?.processTimeline, null);
  assert.equal(cleared.messages[0]?.plan, null);
  assert.equal(cleared.messages[0]?.activity?.length, 2);
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

test("latest answer group streams in the body until a later tool call demotes it to process", () => {
  const firstAnswer: AgentActivityEvent[] = [
    { type: "process.text", text: "先给出判断", stream: "answer", answerGroup: "response-1", timestamp: "2026-01-01T00:00:01.000Z" },
  ];
  assert.deepEqual(resolveLiveResponseText(firstAnswer), { answerGroup: "response-1", text: "先给出判断" });
  assert.deepEqual(buildProcessTimeline(firstAnswer, "response-1"), []);

  const afterTool: AgentActivityEvent[] = [
    ...firstAnswer,
    { type: "tool.started", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "tool.completed", toolCallId: "tool-1", name: "Read", timestamp: "2026-01-01T00:00:03.000Z" },
  ];
  assert.equal(resolveLiveResponseText(afterTool), undefined);
  assert.deepEqual(buildProcessTimeline(afterTool).map((entry) => entry.kind), ["text", "tools"]);

  const finalAnswer: AgentActivityEvent[] = [
    ...afterTool,
    { type: "process.text", text: "最终", stream: "answer", answerGroup: "response-2", timestamp: "2026-01-01T00:00:04.000Z" },
    { type: "process.text", text: "正文", stream: "answer", answerGroup: "response-2", timestamp: "2026-01-01T00:00:05.000Z" },
  ];
  assert.deepEqual(resolveLiveResponseText(finalAnswer), { answerGroup: "response-2", text: "最终正文" });
  assert.deepEqual(
    buildProcessTimeline(finalAnswer, "response-2").map((entry) => entry.kind),
    ["text", "tools"],
  );
});

test("persisted process timeline restores narration and compact tool groups in order", () => {
  const timeline = buildProcessTimeline(undefined, null, [
    { type: "text", text: "先检查。" },
    { type: "tools", count: 5, failedCount: 1 },
    { type: "text", text: "继续验证。" },
    { type: "tools", count: 3, failedCount: 0 },
  ]);
  assert.deepEqual(timeline.map((entry) => entry.kind), ["text", "tool-summary", "text", "tool-summary"]);
  assert.deepEqual(timeline[1], { kind: "tool-summary", count: 5, failedCount: 1 });
  assert.deepEqual(timeline[3], { kind: "tool-summary", count: 3, failedCount: 0 });
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
