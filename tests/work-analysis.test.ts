import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkAnalysis } from "../src/core/work-analysis.ts";
import type { ChatMessage, Conversation } from "../src/shared/types.ts";

const conversation: Conversation = {
  id: "conv-1",
  workspaceId: "ws-1",
  name: "登录功能",
  createdAt: "2026-06-01T00:00:00.000Z",
  lastOpenedAt: "2026-06-20T00:00:00.000Z",
};

function user(id: string, content: string, createdAt: string): ChatMessage {
  return { id, kind: "user", content, createdAt, status: "done" };
}

function run(input: {
  id: string;
  parentMessageId: string;
  agentId: string;
  status: "queued" | "completed" | "failed" | "cancelled" | "running";
  startedAt?: string;
  completedAt?: string;
}): ChatMessage {
  return {
    id: input.id,
    kind: "agent",
    content: `${input.agentId} result`,
    createdAt: input.startedAt ?? "2026-06-19T10:00:00.000Z",
    parentMessageId: input.parentMessageId,
    agentId: input.agentId,
    runId: `run-${input.id}`,
    runStatus: input.status,
    status: input.status === "completed" ? "done" : input.status === "running" || input.status === "queued" ? "running" : input.status === "failed" ? "error" : "cancelled",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
}

test("buildWorkAnalysis groups downstream employee runs into one task", () => {
  const messages: ChatMessage[] = [
    user("msg-1", "@pm: 实现登录功能", "2026-06-19T10:00:00.000Z"),
    run({ id: "msg-2", parentMessageId: "msg-1", agentId: "pm", status: "completed", startedAt: "2026-06-19T10:00:10.000Z", completedAt: "2026-06-19T10:00:40.000Z" }),
    run({ id: "msg-3", parentMessageId: "msg-2", agentId: "developer", status: "completed", startedAt: "2026-06-19T10:00:45.000Z", completedAt: "2026-06-19T10:02:45.000Z" }),
    run({ id: "msg-4", parentMessageId: "msg-3", agentId: "tester", status: "completed", startedAt: "2026-06-19T10:03:00.000Z", completedAt: "2026-06-19T10:04:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map([["pm", "产品经理"], ["developer", "开发工程师"], ["tester", "测试工程师"]]),
    days: 30,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.completedTasks, 1);
  assert.equal(analysis.summary.participatingAgents, 3);
  assert.equal(analysis.summary.multiAgentRate, 1);
  assert.equal(analysis.summary.medianDurationMs, 4 * 60 * 1000);
  assert.deepEqual(analysis.tasks[0].agents.map((agent) => agent.label), ["产品经理", "开发工程师", "测试工程师"]);
  assert.equal(analysis.tasks[0].title, "实现登录功能");
});

test("buildWorkAnalysis includes ongoing tasks and excludes out-of-range tasks", () => {
  const messages: ChatMessage[] = [
    user("old", "@pm: old", "2026-04-01T10:00:00.000Z"),
    run({ id: "old-run", parentMessageId: "old", agentId: "pm", status: "completed", startedAt: "2026-04-01T10:00:00.000Z", completedAt: "2026-04-01T10:01:00.000Z" }),
    user("active", "@developer: active", "2026-06-19T10:00:00.000Z"),
    run({ id: "active-run", parentMessageId: "active", agentId: "developer", status: "running", startedAt: "2026-06-19T10:00:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 30,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.totalTasks, 1);
  assert.equal(analysis.summary.runningTasks, 1);
  assert.equal(analysis.summary.completedTasks, 0);
  assert.equal(analysis.tasks[0].status, "running");
  assert.equal(analysis.tasks[0].durationMs, 26 * 60 * 60 * 1000);
  assert.equal(analysis.trend.length, 30);
});

test("buildWorkAnalysis reports failed and cancelled tasks without counting them as completed", () => {
  const messages: ChatMessage[] = [
    user("failed", "@developer: 修复构建", "2026-06-18T10:00:00.000Z"),
    run({ id: "failed-run", parentMessageId: "failed", agentId: "developer", status: "failed", startedAt: "2026-06-18T10:00:05.000Z", completedAt: "2026-06-18T10:03:00.000Z" }),
    user("cancelled", "@tester: 运行测试", "2026-06-19T10:00:00.000Z"),
    run({ id: "cancelled-run", parentMessageId: "cancelled", agentId: "tester", status: "cancelled", startedAt: "2026-06-19T10:00:05.000Z", completedAt: "2026-06-19T10:01:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.deepEqual(analysis.summary, {
    totalTasks: 2,
    runningTasks: 0,
    completedTasks: 0,
    failedTasks: 1,
    cancelledTasks: 1,
    participatingAgents: 2,
    multiAgentRate: 0,
    medianDurationMs: 0,
  });
});

test("buildWorkAnalysis ignores a cancelled queued branch when later work completes", () => {
  const messages: ChatMessage[] = [
    user("root", "完成协作任务", "2026-06-19T10:00:00.000Z"),
    run({ id: "queued-cancel", parentMessageId: "root", agentId: "supervisor", status: "cancelled", completedAt: "2026-06-19T10:00:20.000Z" }),
    run({ id: "completed", parentMessageId: "root", agentId: "developer", status: "completed", startedAt: "2026-06-19T10:00:30.000Z", completedAt: "2026-06-19T10:01:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.tasks[0].status, "completed");
});

test("buildWorkAnalysis marks a task cancelled when its final started branch is cancelled", () => {
  const messages: ChatMessage[] = [
    user("root", "停止协作任务", "2026-06-19T10:00:00.000Z"),
    run({ id: "completed", parentMessageId: "root", agentId: "developer", status: "completed", startedAt: "2026-06-19T10:00:05.000Z", completedAt: "2026-06-19T10:00:20.000Z" }),
    run({ id: "cancelled", parentMessageId: "root", agentId: "tester", status: "cancelled", startedAt: "2026-06-19T10:00:25.000Z", completedAt: "2026-06-19T10:00:40.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.tasks[0].status, "cancelled");
});

test("buildWorkAnalysis marks a task cancelled when all queued work is cancelled before starting", () => {
  const messages: ChatMessage[] = [
    user("root", "取消尚未开始的任务", "2026-06-19T10:00:00.000Z"),
    run({ id: "queued-cancel", parentMessageId: "root", agentId: "developer", status: "cancelled", completedAt: "2026-06-19T10:00:10.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.tasks[0].status, "cancelled");
});

test("buildWorkAnalysis includes a supervisor-only task", () => {
  const messages: ChatMessage[] = [
    user("root", "整理项目进展", "2026-06-19T10:00:00.000Z"),
    run({ id: "supervisor-run", parentMessageId: "root", agentId: "supervisor", status: "completed", startedAt: "2026-06-19T10:00:05.000Z", completedAt: "2026-06-19T10:01:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map([["supervisor", "主管"]]),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.totalTasks, 1);
  assert.deepEqual(analysis.tasks[0].agents.map((agent) => agent.label), ["主管"]);
  assert.deepEqual(analysis.tasks[0].runs.map((item) => item.agentId), ["supervisor"]);
});

test("buildWorkAnalysis exposes overlapping runs as parallel timeline entries", () => {
  const messages: ChatMessage[] = [
    user("root", "并行检查功能", "2026-06-19T10:00:00.000Z"),
    run({ id: "developer-run", parentMessageId: "root", agentId: "developer", status: "completed", startedAt: "2026-06-19T10:00:10.000Z", completedAt: "2026-06-19T10:02:10.000Z" }),
    run({ id: "tester-run", parentMessageId: "root", agentId: "tester", status: "completed", startedAt: "2026-06-19T10:01:00.000Z", completedAt: "2026-06-19T10:03:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.tasks[0].hasParallelRuns, true);
  assert.deepEqual(analysis.tasks[0].runs.map((item) => item.offsetMs), [10_000, 60_000]);
});

test("buildWorkAnalysis strips assignment markers (including the fullwidth colon) from the task title", () => {
  const messages: ChatMessage[] = [
    user("fw", "@pm：用全角冒号指派", "2026-06-19T10:00:00.000Z"),
    run({ id: "fw-run", parentMessageId: "fw", agentId: "pm", status: "completed", startedAt: "2026-06-19T10:00:10.000Z", completedAt: "2026-06-19T10:00:40.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.tasks[0].title, "用全角冒号指派");
});

test("buildWorkAnalysis surfaces a long task whose root user message predates the window", () => {
  // Simulates the post-historySince state: the originating user message lives
  // in an older shard that historySince excluded, so only the in-window run
  // reaches buildWorkAnalysis. The task must still be surfaced (e.g. in the
  // in-progress view) instead of being dropped.
  const messages: ChatMessage[] = [
    run({ id: "long-run", parentMessageId: "old-root", agentId: "developer", status: "running", startedAt: "2026-06-19T10:00:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map([["developer", "开发"]]),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.totalTasks, 1);
  assert.equal(analysis.summary.runningTasks, 1);
  assert.equal(analysis.tasks[0].status, "running");
  assert.equal(analysis.tasks[0].agents[0].label, "开发");
});

test("buildWorkAnalysis groups in-window runs sharing an out-of-window root into one task", () => {
  // A delegation chain rooted before the window: both runs are in-window, but
  // their shared user root is outside it. They should collapse into one task
  // anchored on the earliest in-window run, not become two orphan tasks.
  const messages: ChatMessage[] = [
    run({ id: "chain-a", parentMessageId: "old-root", agentId: "pm", status: "completed", startedAt: "2026-06-19T10:00:00.000Z", completedAt: "2026-06-19T10:01:00.000Z" }),
    run({ id: "chain-b", parentMessageId: "chain-a", agentId: "developer", status: "running", startedAt: "2026-06-19T10:01:30.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map([["pm", "产品"], ["developer", "开发"]]),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.totalTasks, 1);
  assert.equal(analysis.summary.runningTasks, 1);
  assert.equal(analysis.tasks[0].status, "running");
  assert.deepEqual(analysis.tasks[0].agents.map((agent) => agent.agentId), ["pm", "developer"]);
});

test("buildWorkAnalysis treats a recovered failed run as a completed task", () => {
  const messages: ChatMessage[] = [
    user("root", "@developer: 修复登录", "2026-06-19T10:00:00.000Z"),
    run({ id: "first", parentMessageId: "root", agentId: "developer", status: "failed", startedAt: "2026-06-19T10:00:05.000Z", completedAt: "2026-06-19T10:01:00.000Z" }),
    { id: "retry", kind: "system", content: "重新执行", createdAt: "2026-06-19T10:01:01.000Z", parentMessageId: "first" },
    run({ id: "second", parentMessageId: "retry", agentId: "developer", status: "completed", startedAt: "2026-06-19T10:01:05.000Z", completedAt: "2026-06-19T10:02:00.000Z" }),
  ];

  const analysis = buildWorkAnalysis({
    workspaceId: "ws-1",
    conversations: [{ conversation, messages }],
    agentLabels: new Map(),
    days: 7,
    now: new Date("2026-06-20T12:00:00.000Z"),
  });

  assert.equal(analysis.summary.completedTasks, 1);
  assert.equal(analysis.summary.failedTasks, 0);
  assert.equal(analysis.tasks[0].agents[0].status, "completed");
  assert.equal(analysis.tasks[0].agents[0].runCount, 2);
});
