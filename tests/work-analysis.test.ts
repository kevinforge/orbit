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
  status: "completed" | "failed" | "cancelled" | "running";
  startedAt: string;
  completedAt?: string;
}): ChatMessage {
  return {
    id: input.id,
    kind: "agent",
    content: `${input.agentId} result`,
    createdAt: input.startedAt,
    parentMessageId: input.parentMessageId,
    agentId: input.agentId,
    runId: `run-${input.id}`,
    runStatus: input.status,
    status: input.status === "completed" ? "done" : input.status === "running" ? "running" : input.status === "failed" ? "error" : "cancelled",
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

test("buildWorkAnalysis excludes unfinished and out-of-range tasks", () => {
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

  assert.equal(analysis.summary.totalTasks, 0);
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
    completedTasks: 0,
    failedTasks: 1,
    cancelledTasks: 1,
    participatingAgents: 2,
    multiAgentRate: 0,
    medianDurationMs: 0,
  });
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
