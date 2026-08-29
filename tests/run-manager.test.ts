import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../src/core/event-bus.ts";
import { AgentRunCancelledError } from "../src/core/agent-runtime.ts";
import { MessageStore } from "../src/core/message-store.ts";
import { classifyTerminalActivities, classifyTerminalActivity, RunManager } from "../src/core/run-manager.ts";
import type { AgentActivityEvent, AgentId, ChatMessage, MessageAttachment, RunResult, RuntimeEvent } from "../src/shared/types.ts";

/** 捕获某个 run 的实时 run.activity 事件（工具/状态/过程文本都只走这条通道）。 */
function captureRunActivity(eventBus: EventBus, runId: string): AgentActivityEvent[] {
  const activities: AgentActivityEvent[] = [];
  eventBus.subscribe((event: RuntimeEvent) => {
    if (event.type === "run.activity" && event.runId === runId) {
      activities.push(event.activity);
    }
  });
  return activities;
}

type Deferred = {
  promise: Promise<RunResult>;
  resolve: (value: RunResult) => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: (value: RunResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RunResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSourceMessage(): ChatMessage {
  return {
    id: "msg_source",
    kind: "user",
    content: "@developer: work",
    createdAt: new Date().toISOString(),
    status: "sent",
  };
}

/** Mock agent runner that supports both send and interrupt. */
function mockAgentRunner(
  send: (runId: string, prompt: string) => Promise<RunResult>,
  interrupt: (runId: string) => boolean = () => true,
): { send: (runId: string, prompt: string) => Promise<RunResult>; interrupt: (runId: string) => boolean } {
  return { send, interrupt };
}

test("queues a second run for the same agent until the first completes", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const calls: Array<{ agentId: AgentId; runId: string; prompt: string }> = [];
  const first = deferred();
  const second = deferred();
  const pending = [first, second];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get(agentId) {
        return {
          send(runId: string, prompt: string) {
            calls.push({ agentId, runId, prompt });
            return pending.shift()?.promise ?? Promise.reject(new Error("unexpected run"));
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return `context\n${prompt}`;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "first", source);
  manager.enqueue("developer", "second", source);

  assert.equal(calls.length, 1);
  assert.equal(messages.list()[1]?.content, "developer queued...");

  first.resolve({ content: "first done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.prompt, "context\nsecond");

  second.resolve({ content: "second done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.list()[0]?.status, "done");
  assert.equal(messages.list()[1]?.status, "done");
});

test("cancelAgentRuns clears a supervisor queue and active run", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const calls: string[] = [];
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string) {
            calls.push(runId);
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const active = manager.enqueue("supervisor", "first", source);
  const queued = manager.enqueue("supervisor", "second", source);
  const cancelled = manager.cancelAgentRuns("supervisor");

  assert.deepEqual(cancelled, [queued.id, active.id]);
  assert.equal(active.status, "cancelling");
  assert.equal(queued.status, "cancelled");
  assert.deepEqual(calls, [active.id]);

  first.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active.status, "cancelled");
});

test("mixed attachments: the full metadata list reaches the runtime and the prompt intact", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  let sentAttachments: (readonly MessageAttachment[] | undefined) | undefined;
  let promptedAttachments: unknown;
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(_runId: string, _prompt: string, attachments?: readonly MessageAttachment[]) {
            sentAttachments = attachments;
            return Promise.resolve({ content: "done" });
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId: AgentId, prompt: string, _sourceMessageId?: string, sourceAttachments?: MessageAttachment[]) {
      promptedAttachments = sourceAttachments;
      return prompt;
    },
    onRunCompleted() {},
  });

  const attachments: MessageAttachment[] = [
    {
      id: "a1", kind: "image", mimeType: "image/png", filename: "shot.png",
      path: "/data/shot.png", url: "/api/attachments/ws/conv/a1", size: 2048,
      createdAt: new Date().toISOString(),
    },
    {
      id: "a2", kind: "file", mimeType: "application/pdf", filename: "spec.pdf",
      path: "/data/spec.pdf", url: "/api/attachments/ws/conv/a2", size: 4096,
      createdAt: new Date().toISOString(),
    },
    {
      id: "a3", kind: "file", mimeType: "text/plain", filename: "example.ts",
      path: "/data/example.ts", url: "/api/attachments/ws/conv/a3", size: 1024,
      createdAt: new Date().toISOString(),
    },
  ];
  manager.enqueue("developer", "work", { ...createSourceMessage(), attachments });

  // RunManager 不再把附件压扁成 imagePaths：完整元数据（含类型、MIME、
  // 大小与路径）无损传给 runtime，由 ACP 层决定 image / resource_link。
  assert.deepEqual(
    sentAttachments,
    attachments,
    "runtime must receive the full attachment metadata list, images and files alike",
  );
  assert.equal((promptedAttachments as MessageAttachment[]).length, 3, "prompt builder must receive every attachment");
});

test("propagates the source approval mode to the agent run and result message", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  let receivedMode: string | undefined;
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(_runId, _prompt, _attachments, approvalMode) {
            receivedMode = approvalMode;
            return Promise.resolve({ content: "done" });
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const source = { ...createSourceMessage(), approvalMode: "full-access" as const };
  const run = manager.enqueue("developer", "work", source);

  assert.equal(receivedMode, "full-access");
  assert.equal(messages.get(run.resultMessageId)?.approvalMode, "full-access");
});

test("keeps the latest bounded plan snapshot live and persists it only at settlement", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity: {
      type: "plan.updated",
      plan: { id: "plan-1", format: "markdown", content: "first" },
      timestamp: new Date().toISOString(),
    },
  });
  eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity: {
      type: "plan.updated",
      plan: { id: "plan-1", format: "markdown", content: "x".repeat(20_000) },
      timestamp: new Date().toISOString(),
    },
  });

  // 运行中：Plan 快照只走实时事件，不写入持久化消息。
  assert.equal(messages.get(run.resultMessageId)?.activity, undefined);
  const planEvents = activities.filter((item) => item.type === "plan.updated");
  assert.equal(planEvents.length, 2);
  assert.equal(planEvents[1]?.type === "plan.updated" && planEvents[1].plan.format === "markdown" && planEvents[1].plan.content.length, 10_000);

  pending.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const settled = messages.get(run.resultMessageId);
  assert.equal(settled?.plan?.format, "markdown");
  if (settled?.plan?.format === "markdown") {
    assert.equal(settled.plan.id, "plan-1");
    assert.equal(settled.plan.content.length, 10_000);
  }
  // 结算后：工具/状态活动仍然不落盘。
  assert.equal(settled?.activity, undefined);
});

test("settlement explicitly clears an absent process timeline and a removed plan", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return mockAgentRunner(() => pending.promise);
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());
  const publish = (activity: AgentActivityEvent) => eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity,
  });
  publish({
    type: "plan.updated",
    plan: { id: "plan-1", format: "markdown", content: "temporary" },
    timestamp: new Date().toISOString(),
  });
  publish({ type: "plan.removed", planId: "plan-1", timestamp: new Date().toISOString() });

  pending.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const settled = messages.get(run.resultMessageId);
  assert.equal(settled?.processTimeline, null);
  assert.equal(settled?.plan, null);
  assert.match(JSON.stringify(settled), /"processTimeline":null/);
  assert.match(JSON.stringify(settled), /"plan":null/);
});

test("projects the ordered live process stream and plan without persisting it", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());
  const publish = (activity: AgentActivityEvent) => eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity,
  });
  publish({ type: "status", text: "等待审批：运行测试", timestamp: new Date().toISOString() });
  publish({ type: "process.text", text: "正在检查", timestamp: new Date().toISOString() });
  publish({ type: "plan.updated", plan: { format: "items", entries: [{ content: "检查文件", priority: "high", status: "in_progress" }] }, timestamp: new Date().toISOString() });
  publish({ type: "tool.started", name: "Read", timestamp: new Date().toISOString() });

  const projected = manager.projectLiveProcessState(messages.list());
  const resultMessage = projected.find((message) => message.id === run.resultMessageId);
  assert.equal(resultMessage?.plan?.format, "items");
  assert.deepEqual(
    resultMessage?.activity?.filter((item) => item.type === "process.text" || item.type.startsWith("tool.")).map((item) => item.type),
    ["process.text", "tool.started"],
  );
  assert.ok(resultMessage?.activity?.some((item) => item.type === "status" && item.text === "等待审批：运行测试"));
  assert.equal(messages.get(run.resultMessageId)?.activity, undefined, "projection must not persist tool activity");
});

test("persists an ordered compact process timeline and plan while raw tool activity stays live-only", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const events: RuntimeEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  const publish = (activity: AgentActivityEvent) => eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity,
  });
  const ts = () => new Date().toISOString();

  // 流式过程文本（增量）+ 工具活动 + 最终 Plan + 结算快照。
  publish({ type: "process.text", text: "先检查", stream: "progress", answerGroup: "", timestamp: ts() });
  publish({ type: "process.text", text: "相关文件。", stream: "progress", answerGroup: "", timestamp: ts() });
  publish({ type: "tool.started", toolCallId: "read-1", name: "Read", input: "package.json", timestamp: ts() });
  publish({ type: "tool.completed", toolCallId: "read-1", name: "Read", timestamp: ts() });
  publish({ type: "tool.started", toolCallId: "search-1", name: "Search", timestamp: ts() });
  publish({ type: "tool.failed", toolCallId: "search-1", name: "Search", summary: "not found", timestamp: ts() });
  publish({ type: "process.text", text: "继续验证。", stream: "progress", answerGroup: "", timestamp: ts() });
  publish({ type: "tool.started", toolCallId: "test-1", name: "Test", timestamp: ts() });
  publish({ type: "tool.completed", toolCallId: "test-1", name: "Test", timestamp: ts() });
  publish({ type: "plan.updated", plan: { format: "items", entries: [{ content: "检查文件", priority: "high", status: "completed" }] }, timestamp: ts() });
  publish({ type: "process.text", text: "最终回复正文", stream: "answer", answerGroup: "response-final", timestamp: ts() });
  publish({ type: "process.text", text: "先检查相关文件。继续验证。", snapshot: true, excludedAnswerGroup: "response-final", timestamp: ts() });

  // 运行中：实时流按序收到全部 delta 与工具事件；结算快照是服务端内部
  // 信号，不作为 run.activity 转发，避免前端先清空过程区再等正文。
  assert.equal(activities.length, 11);
  assert.deepEqual(
    activities.map((item) => item.type),
    ["process.text", "process.text", "tool.started", "tool.completed", "tool.started", "tool.failed", "process.text", "tool.started", "tool.completed", "plan.updated", "process.text"],
  );
  assert.ok(activities.every((item) => !(item.type === "process.text" && item.snapshot)), "settlement snapshots must not stream to the client");
  assert.equal(messages.get(run.resultMessageId)?.activity, undefined);
  // 快照之后、终态之前：运行中投影仍保留最终回答分片，不出现结算空档。
  const projected = manager.projectLiveProcessState(messages.list());
  const projectedMessage = projected.find((message) => message.id === run.resultMessageId);
  assert.ok(
    projectedMessage?.activity?.some((item) => item.type === "process.text" && item.text === "最终回复正文"),
    "live projection must keep the final answer until the terminal event",
  );

  pending.resolve({ content: "最终回复正文" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const settled = messages.get(run.resultMessageId);
  // 刷新后可恢复：最终正文、轻量有序过程、Plan；原始工具活动不恢复。
  assert.equal(settled?.content, "最终回复正文");
  assert.deepEqual(settled?.processTimeline, [
    { type: "text", text: "先检查相关文件。" },
    { type: "tools", count: 2, failedCount: 1 },
    { type: "text", text: "继续验证。" },
    { type: "tools", count: 1, failedCount: 0 },
  ]);
  assert.equal(settled?.plan?.format, "items");
  assert.equal(settled?.activity, undefined);
  // 结算事件显式携带最终回答分组：客户端无需按"最后一次工具调用后"推断剔除对象。
  const terminalUpdate = events.find((event) => (
    event.type === "message.updated"
    && event.message.id === run.resultMessageId
    && event.settleTransientActivity === true
  ));
  assert.ok(terminalUpdate, "terminal message update must settle client-only activity");
  assert.equal(
    terminalUpdate?.type === "message.updated" ? terminalUpdate.excludedAnswerGroup : undefined,
    "response-final",
    "terminal message update must carry the settlement snapshot's excluded answer group",
  );
  // 持久化时间线在结算时基于剔除分组后的副本生成，不包含最终回复正文。
  assert.ok(
    settled?.processTimeline?.every((entry) => entry.type !== "text" || !entry.text.includes("最终回复正文")),
    "persisted process timeline must exclude the final answer text",
  );
});

test("terminal events without a settlement snapshot omit excludedAnswerGroup so partial answers survive", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const events: RuntimeEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());

  // 崩溃前的部分回答：没有结算快照，也就没有 excludedAnswerGroup。
  eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity: { type: "process.text", text: "部分回答", stream: "answer", answerGroup: "partial-1", timestamp: new Date().toISOString() },
  });

  pending.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const terminalUpdate = events.find((event) => (
    event.type === "message.updated"
    && event.message.id === run.resultMessageId
    && event.settleTransientActivity === true
  ));
  assert.ok(terminalUpdate, "terminal message update must exist");
  assert.equal(
    terminalUpdate?.type === "message.updated" ? "excludedAnswerGroup" in terminalUpdate : true,
    false,
    "terminal events must omit excludedAnswerGroup when no settlement snapshot arrived",
  );
});

test("caps persisted process timeline text at settlement", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const pending = deferred();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });
  const run = manager.enqueue("developer", "work", createSourceMessage());

  eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: run.id,
    activity: { type: "process.text", text: "x".repeat(30_000), timestamp: new Date().toISOString() },
  });

  pending.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const processTimeline = messages.get(run.resultMessageId)?.processTimeline ?? [];
  const processText = processTimeline.find((entry) => entry.type === "text")?.text ?? "";
  assert.equal(processText.length, 20_000);
  assert.ok(processText.endsWith("…"));
});

test("treats ACP cancellation after permission rejection as a cancelled run", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return Promise.reject(new AgentRunCancelledError(
              "CodeBuddy ACP turn was cancelled.",
              "权限申请已拒绝，任务已停止。",
            ));
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "work", createSourceMessage());
  await new Promise((resolve) => setTimeout(resolve, 0));

  const message = messages.get(run.resultMessageId);
  assert.equal(run.status, "cancelled");
  assert.equal(message?.status, "cancelled");
  assert.equal(message?.runStatus, "cancelled");
  assert.equal(message?.content, "developer 权限申请已拒绝，任务已停止。");
});

test("terminal chunks stream visible tool activity without persisting it", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let activeRunId = "";

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get(agentId) {
        return {
          send(runId: string) {
            activeRunId = runId;
            assert.equal(agentId, "developer");
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "first", source);
  const activities = captureRunActivity(eventBus, run.id);

  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: "Running Bash(command)" });
  assert.ok(activities.some((activity) => activity.type === "tool.started" && activity.name === "Bash"));
  // 工具活动只存在于实时流，运行中与结算后都不落盘。
  assert.equal(messages.get(run.resultMessageId)?.activity, undefined);

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.get(run.resultMessageId)?.activity, undefined);
});

test("classifies noisy terminal output without exposing raw text", () => {
  assert.equal(classifyTerminalActivity("Bash(ls)")?.type, "tool.started");
  assert.equal(classifyTerminalActivity("API Error: 400")?.type, "error");
  assert.equal(classifyTerminalActivity("   "), null);
});

test("classifies Claude stream-json tool events", () => {
  const started = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "pwd" },
        },
      ],
    },
  });
  const completed = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "/d/projects/orbit", is_error: false }],
    },
    tool_use_result: { stdout: "/d/projects/orbit", stderr: "", is_error: false },
  });

  const activities = classifyTerminalActivities(`${started}\n${completed}`);
  assert.deepEqual(
    activities.map((activity) => activity.type),
    ["tool.started", "tool.completed"],
  );
  assert.equal(activities[0]?.type === "tool.started" ? activities[0].name : "", "Bash");
  assert.equal(activities[0]?.type === "tool.started" ? activities[0].input : "", "pwd");
  if (activities[1]?.type === "tool.completed") {
    assert.equal(activities[1].name, "Bash");
    assert.equal(activities[1].summary, undefined);
  }
});

test("classifies tool_use_result with is_error=true as tool.failed", () => {
  const started = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command: "bad-cmd" } }],
    },
  });
  const failed = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "some output", stderr: "command not found", is_error: true },
  });

  const activities = classifyTerminalActivities(`${started}\n${failed}`);
  assert.equal(activities.length, 2);
  assert.equal(activities[0]?.type, "tool.started");
  assert.equal(activities[1]?.type, "tool.failed");
  if (activities[1]?.type === "tool.failed") {
    assert.equal(activities[1].name, "Bash");
    assert.ok(activities[1].summary?.includes("command not found"), `Expected stderr in summary, got: ${activities[1].summary}`);
  }
});

test("tool.failed summary prefers stderr over stdout", () => {
  const failed = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "stdout content", stderr: "stderr content", is_error: true },
  });

  const activities = classifyTerminalActivities(failed);
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.type, "tool.failed");
  if (activities[0]?.type === "tool.failed") {
    assert.ok(activities[0].summary?.includes("stderr content"), `Expected stderr in summary, got: ${activities[0].summary}`);
  }
});

test("tool.failed falls back to stdout when stderr is empty", () => {
  const failed = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "fallback output", stderr: "", is_error: true },
  });

  const activities = classifyTerminalActivities(failed);
  assert.equal(activities[0]?.type, "tool.failed");
  if (activities[0]?.type === "tool.failed") {
    assert.ok(activities[0].summary?.includes("fallback output"), `Expected stdout in summary, got: ${activities[0].summary}`);
  }
});

test("tool.completed does not include stdout/stderr summary", () => {
  const started = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cat large.log" } }] },
  });
  const completed = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "x".repeat(10_000), stderr: "some error output", is_error: false },
  });

  const activities = classifyTerminalActivities(`${started}\n${completed}`);
  assert.equal(activities[1]?.type, "tool.completed");
  if (activities[1]?.type === "tool.completed") {
    assert.equal(activities[1].name, "Bash");
    assert.equal(activities[1].summary, undefined);
  }
});

test("Codex tool.completed does not include aggregated_output summary", () => {
  const completed = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "npm test",
      aggregated_output: "x".repeat(10_000),
      exit_code: 0,
      status: "completed",
    },
  });

  const activities = classifyTerminalActivities(completed);
  assert.equal(activities[0]?.type, "tool.completed");
  if (activities[0]?.type === "tool.completed") {
    assert.equal(activities[0].summary, undefined);
  }
});

test("classifies sequential tool started/completed/failed events in order", () => {
  const started1 = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
  });
  const completed1 = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "file contents", stderr: "", is_error: false },
  });
  const started2 = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "test" } }] },
  });
  const failed2 = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "", stderr: "exit 1", is_error: true },
  });

  const activities = classifyTerminalActivities([started1, completed1, started2, failed2].join("\n"));
  assert.deepEqual(activities.map((a) => a.type), ["tool.started", "tool.completed", "tool.started", "tool.failed"]);
  if (activities[3]?.type === "tool.failed") {
    assert.equal(activities[3].name, "Bash");
  }
});

test("classifies Codex command execution items in order", () => {
  const started = JSON.stringify({
    type: "item.started",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"git status\"",
      status: "in_progress",
    },
  });
  const completed = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "\"C:\\\\windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"git status\"",
      aggregated_output: "## fix/issue-14-activity-tool-visibility",
      exit_code: 0,
      status: "completed",
    },
  });

  const activities = classifyTerminalActivities(`${started}${completed}`);

  assert.deepEqual(activities.map((a) => a.type), ["tool.started", "tool.completed"]);
  assert.equal(activities[0]?.type === "tool.started" ? activities[0].name : "", "PowerShell");
  if (activities[1]?.type === "tool.completed") {
    assert.equal(activities[1].name, "PowerShell");
    assert.equal(activities[1].summary, undefined);
  }
});

test("classifies failed Codex command execution", () => {
  const completed = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "bash -lc \"npm test\"",
      aggregated_output: "Error: failed test",
      exit_code: 1,
      status: "completed",
    },
  });

  const activities = classifyTerminalActivities(completed);

  assert.equal(activities[0]?.type, "tool.failed");
  if (activities[0]?.type === "tool.failed") {
    assert.equal(activities[0].name, "Bash");
    assert.equal(activities[0].summary, "Error: failed test");
  }
});

test("split Claude tool_use across two terminal chunks still produces tool.started", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let activeRunId = "";

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string) {
            activeRunId = runId;
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split tool_use test", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  const fullJson = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/main.ts" } }] },
  });
  const mid = Math.floor(fullJson.length / 2);
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: fullJson.slice(0, mid) });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: fullJson.slice(mid) });

  const toolStarted = activities.find((a) => a.type === "tool.started");
  assert.ok(toolStarted, "Expected tool.started from split tool_use JSON");
  if (toolStarted?.type === "tool.started") {
    assert.equal(toolStarted.name, "Read");
    assert.equal(toolStarted.input, "src/main.ts");
  }

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("split Claude tool_use_result across chunks still produces tool.completed with summary", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let activeRunId = "";

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string) {
            activeRunId = runId;
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split result test", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  const started = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
  });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: `${started}\n` });

  const resultJson = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "file1.ts\nfile2.ts", stderr: "", is_error: false },
  });
  const mid = Math.floor(resultJson.length / 2);
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: resultJson.slice(0, mid) });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: resultJson.slice(mid) });

  const toolCompleted = activities.find((a) => a.type === "tool.completed");
  assert.ok(toolCompleted, "Expected tool.completed from split tool_use_result JSON");
  if (toolCompleted?.type === "tool.completed") {
    assert.equal(toolCompleted.name, "Bash");
    assert.equal(toolCompleted.summary, undefined);
  }

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("split Claude tool_use_result error across chunks still produces tool.failed", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let activeRunId = "";

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string) {
            activeRunId = runId;
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split failed result test", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  const started = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bad" } }] },
  });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: `${started}\n` });

  const failedJson = JSON.stringify({
    type: "user",
    tool_use_result: { stdout: "", stderr: "command not found", is_error: true },
  });
  const mid = Math.floor(failedJson.length / 2);
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: failedJson.slice(0, mid) });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: failedJson.slice(mid) });

  const toolFailed = activities.find((a) => a.type === "tool.failed");
  assert.ok(toolFailed, "Expected tool.failed from split error tool_use_result JSON");
  if (toolFailed?.type === "tool.failed") {
    assert.equal(toolFailed.name, "Bash");
    assert.ok(toolFailed.summary?.includes("command not found"), `Expected stderr in summary, got: ${toolFailed.summary}`);
  }

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("split Codex command_execution completion across chunks still produces tool.completed", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let activeRunId = "";

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string) {
            activeRunId = runId;
            return first.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split codex test", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);

  const started = JSON.stringify({
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "git status", status: "in_progress" },
  });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: `${started}\n` });

  const completedJson = JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "git status", aggregated_output: "On branch main", exit_code: 0, status: "completed" },
  });
  const mid = Math.floor(completedJson.length / 2);
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: completedJson.slice(0, mid) });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: completedJson.slice(mid) });

  const toolCompleted = activities.find((a) => a.type === "tool.completed");
  assert.ok(toolCompleted, "Expected tool.completed from split Codex command_execution JSON");
  if (toolCompleted?.type === "tool.completed") {
    assert.equal(toolCompleted.name, "Command");
    assert.equal(toolCompleted.summary, undefined);
  }

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("cancel a queued run prevents it from starting when the active run completes", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const calls: Array<{ agentId: AgentId; runId: string }> = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get(agentId) {
        return {
          send(runId: string) {
            calls.push({ agentId, runId });
            return pending.shift()?.promise ?? Promise.reject(new Error("unexpected"));
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "first", source);
  const queued = manager.enqueue("developer", "second", source);

  assert.equal(queued.status, "queued");
  assert.equal(calls.length, 1, "only the first run starts");

  // Cancel the queued run
  const result = manager.cancel(queued.id);
  assert.equal(result.ok, true, "cancel should return ok:true for queued run");

  const cancelledMsg = messages.get(queued.resultMessageId);
  assert.equal(cancelledMsg?.status, "cancelled");
  assert.equal(cancelledMsg?.runStatus, "cancelled");
  assert.ok(cancelledMsg?.content.includes("排队任务已取消"));

  // Complete the active run — cancelled queued run should NOT start
  first.resolve({ content: "first done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, "cancelled queued run should not start");
});

test("cancel a running run triggers interrupt and succeeds", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let interruptedRunId: string | null = null;

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return first.promise; },
          interrupt(runId: string) {
            interruptedRunId = runId;
            return true;
          },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  const activities = captureRunActivity(eventBus, run.id);
  assert.equal(run.status, "running");

  const result = manager.cancel(run.id);
  assert.equal(result.ok, true);
  assert.equal(run.status, "cancelling", "run should expose cancellation while the runtime is settling");
  assert.equal(interruptedRunId, run.id, "interrupt should be called with correct runId");

  assert.equal(messages.get(run.resultMessageId)?.status, "cancelling");
  first.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Verify run.cancelled event was published after the runtime settled
  const msg = messages.get(run.resultMessageId);
  assert.equal(msg?.status, "cancelled");
  assert.ok(activities.some((a) => a.type === "status" && a.text === "运行已取消。"));
  assert.equal(msg?.activity, undefined, "cancel status stays live-only and is not persisted");
});

test("cancelling a running run starts the next queued run (no stall, FIFO preserved)", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();   // R1, interrupted
  const second = deferred();  // R2, should start after R1 is cancelled
  const pending = [first, second];
  const calls: Array<{ runId: string; prompt: string }> = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(runId: string, prompt: string) {
            calls.push({ runId, prompt });
            return pending.shift()?.promise ?? Promise.reject(new Error("unexpected run"));
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const r1 = manager.enqueue("developer", "R1", source);   // running
  const r2 = manager.enqueue("developer", "R2", source);   // queued behind r1
  assert.equal(r2.status, "queued");

  // Request cancellation for R1 — R2 must wait until R1 actually settles.
  manager.cancel(r1.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.map((c) => c.prompt), ["R1"], "R2 must not start while cancellation is pending");
  assert.equal(r1.status, "cancelling");
  first.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.map((c) => c.prompt), ["R1", "R2"], "R2 should start after R1 is cancelled");
  assert.equal(r2.status, "running", "R2 should now be running");

  // A late R1 settlement must not disturb the now-running R2.
  first.reject(new Error("killed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(r2.status, "running", "late settlement of cancelled R1 must not stop R2");

  // FIFO: a new R3 enqueued after must queue behind R2, not jump ahead of it.
  const r3 = manager.enqueue("developer", "R3", source);
  assert.equal(r3.status, "queued", "R3 must queue behind the running R2 (FIFO preserved)");

  second.resolve({ content: "R2 done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("forced cancel settles the message, releases the slot, and ignores late runtime events", async () => {
  // Issue #136：runtime 无视取消且 prompt 永不结算时，适配层在宽限期后以
  // AgentRunCancelledError 强制收口（见 acp-runtime.test.ts）。这里验证
  // RunManager 收到该结果后的行为：消息落定为已取消、槽位释放、队列推进、
  // 晚到的 runtime 活动不影响已取消的运行。
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const prompts: string[] = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send(_runId: string, prompt: string) {
            prompts.push(prompt);
            return pending.shift()?.promise ?? Promise.reject(new Error("unexpected run"));
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const r1 = manager.enqueue("developer", "R1", source);
  const r2 = manager.enqueue("developer", "R2", source);
  const r1Activities = captureRunActivity(eventBus, r1.id);

  manager.cancel(r1.id);
  assert.equal(r1.status, "cancelling");

  first.reject(new AgentRunCancelledError("CodeBuddy ACP turn was force-cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.get(r1.resultMessageId)?.status, "cancelled", "强制收口后消息必须落定为已取消");
  assert.deepEqual(prompts, ["R1", "R2"], "槽位释放后队列中的下一条必须启动");
  assert.equal(r2.status, "running");

  const settledActivityCount = r1Activities.length;
  eventBus.publish({
    type: "runtime.activity",
    conversationId: "test-conv",
    agentId: "developer",
    runId: r1.id,
    activity: { type: "status", text: "晚到活动", timestamp: new Date().toISOString() },
  } satisfies RuntimeEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(r1Activities.length, settledActivityCount, "已取消运行不得再接收晚到的活动");
  assert.ok(
    !r1Activities.some((activity) => activity.type === "status" && activity.text === "晚到活动"),
    "晚到的 runtime 活动必须被丢弃",
  );

  second.resolve({ content: "R2 done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("cancel a non-existent run returns not_found error", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return Promise.resolve({ content: "ok" }); }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const result = manager.cancel("nonexistent-run");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
});

test("completed runs are released while retaining a short-lived cancellation result", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = manager.cancel(run.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_cancellable");
});

test("cancel publishes run.cancelled event for queued runs", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const events: Array<{ type: string }> = [];

  // Enqueue two runs so the second is queued
  const pending = [first, deferred()];
  let callIdx = 0;
  eventBus.subscribe((event) => { events.push(event as { type: string }); });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return pending[callIdx++]!.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "first", source);
  const queued = manager.enqueue("developer", "second", source);
  assert.equal(queued.status, "queued");

  const result = manager.cancel(queued.id);
  assert.equal(result.ok, true);
  assert.equal(manager.cancel(queued.id).reason, "not_cancellable");

  const cancelledEvents = events.filter((e) => e.type === "run.cancelled");
  assert.equal(cancelledEvents.length, 1, "should publish one run.cancelled event");
});

test("cancel a running run publishes run.cancelled event", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const events: Array<{ type: string }> = [];

  eventBus.subscribe((event) => { events.push(event as { type: string }); });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  const result = manager.cancel(run.id);
  assert.equal(result.ok, true);

  first.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancelledEvents = events.filter((e) => e.type === "run.cancelled");
  assert.equal(cancelledEvents.length, 1, "interrupted running runs should publish run.cancelled");
  assert.equal(manager.cancel(run.id).reason, "not_cancellable");
});

test("queued run cancel sets runStatus on message", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run1 = manager.enqueue("developer", "first", source);
  const run2 = manager.enqueue("developer", "second", source);

  // Check initial runStatus values
  assert.equal(messages.get(run1.resultMessageId)?.runStatus, "running");
  assert.equal(messages.get(run2.resultMessageId)?.runStatus, "queued");

  // Cancel the queued run
  manager.cancel(run2.id);
  assert.equal(messages.get(run2.resultMessageId)?.runStatus, "cancelled");
  assert.equal(messages.get(run2.resultMessageId)?.status, "cancelled");

  // First run still running
  assert.equal(messages.get(run1.resultMessageId)?.runStatus, "running");
});

test("run failures store a concise error instead of raw stream output", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const failure = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return failure.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "first", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);
  const rawEvent = JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "x".repeat(5_000) });
  failure.reject(new Error(rawEvent.repeat(100)));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = messages.get(run.resultMessageId);
  assert.equal(failed?.status, "error");
  assert.ok((failed?.content.length ?? 0) < 2_100, `content was too long: ${failed?.content.length}`);
  assert.ok(!failed?.content.includes("hook_id\":\"" + "x".repeat(100)), "raw JSON should not be persisted in content");

  const lastActivity = activities.at(-1);
  assert.equal(lastActivity?.type, "status");
  assert.ok(lastActivity?.type === "status" && lastActivity.text.length < 2_100);
  assert.equal(failed?.activity, undefined, "failure status stays live-only and is not persisted");
});

test("overloaded runtime failures are summarized without repeated provider noise", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const failure = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return failure.promise;
          },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("supervisor", "first", createSourceMessage());
  const activities = captureRunActivity(eventBus, run.id);
  const rawError = "overloaded overloaded overloaded server_error API Error: 529 [1305] overloaded";
  eventBus.publish({
    type: "terminal.chunk",
    conversationId: "test-conv",
    agentId: "supervisor",
    runId: run.id,
    text: rawError,
  });
  failure.reject(new Error(rawError));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = messages.get(run.resultMessageId);
  assert.equal(failed?.status, "error");
  assert.ok(failed?.content.includes("529 overloaded"), `expected concise overloaded summary, got: ${failed?.content}`);
  assert.equal((failed?.content.match(/overloaded/g) ?? []).length, 1);

  const errorActivity = activities.find((activity) => activity.type === "error");
  assert.ok(errorActivity?.type === "error" && errorActivity.message.includes("529 overloaded"));
});

test("CLI crash that streamed assistant text surfaces that text, not the generic fallback", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const failure = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send() { return failure.promise; }, interrupt() { return true; } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "first", createSourceMessage());
  // Non-zero exit with incomplete stream-json: an assistant text event was
  // streamed, but there is no result/error event to extract.
  const partial = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "I was halfway through editing src/app.ts when the process died." }] },
  });
  failure.reject(new Error(partial));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = messages.get(run.resultMessageId);
  assert.equal(failed?.status, "error");
  assert.ok(
    failed?.content.includes("I was halfway through editing src/app.ts"),
    `expected the streamed assistant text in the failure content, got: ${failed?.content}`,
  );
  assert.ok(
    !failed?.content.includes("Runtime failed. Check the transcript"),
    `expected not to fall back to the generic message, got: ${failed?.content}`,
  );
});

test("CLI crash with no extractable signal gives a specific clue, not the generic fallback", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const failure = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send() { return failure.promise; }, interrupt() { return true; } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "first", createSourceMessage());
  // Non-zero exit with stream-json that carries no error/result/assistant signal.
  const noise = JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "x".repeat(200) });
  failure.reject(new Error(noise));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = messages.get(run.resultMessageId);
  assert.equal(failed?.status, "error");
  assert.ok(
    !failed?.content.includes("Runtime failed. Check the transcript"),
    `expected not to fall back to the generic message, got: ${failed?.content}`,
  );
  assert.ok(
    /运行异常终止|未收到.*最终结果/.test(failed?.content ?? ""),
    `expected a specific no-result clue, got: ${failed?.content}`,
  );
  assert.ok(!failed?.content.includes("hook_id"), "raw JSON fields should not leak into content");
});

test("interruptCurrentChain cancels all queued runs", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const pending = [first, second, third];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const running = manager.enqueue("developer", "first", source);
  const queuedRun = manager.enqueue("developer", "second", source);
  const queuedRun2 = manager.enqueue("developer", "third", source);

  assert.equal(running.status, "running");
  assert.equal(queuedRun.status, "queued");
  assert.equal(queuedRun2.status, "queued");

  const result = manager.interruptCurrentChain();
  assert.equal(result.cancelledQueuedRunIds.length, 2);
  assert.ok(result.cancelledQueuedRunIds.includes(queuedRun.id));
  assert.ok(result.cancelledQueuedRunIds.includes(queuedRun2.id));
  assert.equal(result.suppressedRunningRunIds.length, 1);
  assert.ok(result.suppressedRunningRunIds.includes(running.id));

  // Queued messages should be cancelled
  assert.equal(messages.get(queuedRun.resultMessageId)?.status, "cancelled");
  assert.equal(messages.get(queuedRun2.resultMessageId)?.status, "cancelled");

  // Running run should be marked with suppressFollowupRouting
  assert.equal(running.suppressFollowupRouting, true);

  // Complete the running run — should not crash
  first.resolve({ content: "first done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.get(running.resultMessageId)?.status, "done");
});

test("interruptCurrentChain does not suppress when no running runs", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send() { return Promise.resolve({ content: "ok" }); }, interrupt() { return true; } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  // No runs at all
  const result = manager.interruptCurrentChain();
  assert.equal(result.cancelledQueuedRunIds.length, 0);
  assert.equal(result.suppressedRunningRunIds.length, 0);
});

test("interruptAll discards queued runs and requests cancellation across agents", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const devRunning = deferred();
  const revRunning = deferred();
  const pending = [devRunning, revRunning];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const devRun = manager.enqueue("developer", "work", source);
  const devQueued1 = manager.enqueue("developer", "queued-1", source);
  const devQueued2 = manager.enqueue("developer", "queued-2", source);
  const revRun = manager.enqueue("reviewer", "review", source);
  const revQueued1 = manager.enqueue("reviewer", "queued-rev", source);

  assert.equal(devRun.status, "running");
  assert.equal(devQueued1.status, "queued");
  assert.equal(devQueued2.status, "queued");
  assert.equal(revRun.status, "running");
  assert.equal(revQueued1.status, "queued");

  const result = manager.interruptAll();

  // 3 queued runs discarded
  assert.equal(result.cancelledQueuedRunIds.length, 3);
  assert.ok(result.cancelledQueuedRunIds.includes(devQueued1.id));
  assert.ok(result.cancelledQueuedRunIds.includes(devQueued2.id));
  assert.ok(result.cancelledQueuedRunIds.includes(revQueued1.id));

  // 2 running runs are now cancelling
  assert.equal(result.cancellingRunningRunIds.length, 2);
  assert.ok(result.cancellingRunningRunIds.includes(devRun.id));
  assert.ok(result.cancellingRunningRunIds.includes(revRun.id));

  // Queued messages marked discarded (frontend filters them out)
  assert.equal(messages.get(devQueued1.resultMessageId)?.discarded, true);
  assert.equal(messages.get(devQueued2.resultMessageId)?.discarded, true);
  assert.equal(messages.get(revQueued1.resultMessageId)?.discarded, true);

  // Running messages first expose cancellation in progress
  assert.equal(messages.get(devRun.resultMessageId)?.status, "cancelling");
  assert.equal(messages.get(revRun.resultMessageId)?.status, "cancelling");
  assert.equal(messages.get(devRun.resultMessageId)?.discarded, undefined);
  assert.equal(messages.get(revRun.resultMessageId)?.discarded, undefined);

  // cancel() path does not set suppressFollowupRouting on cancelled runs
  assert.equal(devRun.suppressFollowupRouting, undefined);
  assert.equal(revRun.suppressFollowupRouting, undefined);

  // The next queue step waits until both runtimes settle.
  devRunning.reject(new AgentRunCancelledError("cancelled"));
  revRunning.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.get(devRun.resultMessageId)?.status, "cancelled");
  assert.equal(messages.get(revRun.resultMessageId)?.status, "cancelled");
});

test("interruptAll with no runs returns empty result", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send() { return Promise.resolve({ content: "ok" }); }, interrupt() { return true; } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const result = manager.interruptAll();
  assert.equal(result.cancelledQueuedRunIds.length, 0);
  assert.equal(result.cancellingRunningRunIds.length, 0);
});

test("interruptAll allows new runs to start after interrupt", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const running = manager.enqueue("developer", "first", source);
  assert.equal(running.status, "running");

  manager.interruptAll();
  assert.equal(running.status, "cancelling");

  // The active slot remains occupied until cancellation settles.
  const next = manager.enqueue("developer", "next", source);
  assert.equal(next.status, "queued");

  first.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(running.status, "cancelled");
  assert.equal(next.status, "running");
  second.resolve({ content: "next done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.get(next.resultMessageId)?.status, "done");
});

test("completed suppressed run does NOT call onRunCompleted but still publishes run.completed", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let onRunCompletedCalls = 0;
  const completedEvents: Array<{ suppressFollowupRouting?: boolean }> = [];

  eventBus.subscribe((event) => {
    const e = event as { type: string; suppressFollowupRouting?: boolean };
    if (e.type === "run.completed") {
      completedEvents.push({ suppressFollowupRouting: e.suppressFollowupRouting });
    }
  });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() { onRunCompletedCalls++; },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  // Interrupt — marks running run as suppressed
  manager.interruptCurrentChain();
  assert.equal(run.suppressFollowupRouting, true);

  // Complete the running run
  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // onRunCompleted should NOT be called
  assert.equal(onRunCompletedCalls, 0, "suppressed run should not trigger onRunCompleted");

  // But run.completed should still be published with suppressFollowupRouting flag
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0]?.suppressFollowupRouting, true);
});

test("normal (non-suppressed) runs still call onRunCompleted", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let onRunCompletedCalls = 0;
  const completedMessages: string[] = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted(msg) {
      onRunCompletedCalls++;
      completedMessages.push(msg.content);
    },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");
  assert.equal(run.suppressFollowupRouting, undefined);

  // Complete normally without interrupting
  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(onRunCompletedCalls, 1, "non-suppressed run should call onRunCompleted");
  assert.equal(completedMessages[0], "done");
});

test("enqueue sets origin based on sourceMessage kind", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const deferreds = [deferred(), deferred(), deferred()];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return deferreds.shift()!.promise; }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const userMsg: ChatMessage = { id: "u1", kind: "user", content: "hello", createdAt: new Date().toISOString(), status: "sent" };
  const agentMsg: ChatMessage = { id: "a1", kind: "agent", agentId: "developer", content: "result", createdAt: new Date().toISOString(), status: "done" };
  const systemMsg: ChatMessage = { id: "s1", kind: "system", content: "trigger", createdAt: new Date().toISOString() };

  const userRun = manager.enqueue("developer", "user", userMsg);
  const agentRun = manager.enqueue("tester", "agent", agentMsg);
  const supervisorRun = manager.enqueue("supervisor", "supervisor", systemMsg);

  assert.equal(userRun.origin, "user");
  assert.equal(agentRun.origin, "agent");
  assert.equal(supervisorRun.origin, "supervisor");
});

test("uses provided getAgentLabel for run message content", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return pending.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
    getAgentLabel: (agentId) => (agentId === "supervisor" ? "监督者（supervisor）" : agentId),
  });

  const source = createSourceMessage();
  manager.enqueue("supervisor", "first", source);
  const queued = manager.enqueue("supervisor", "second", source);

  // Enqueued content uses the resolved display name, not the raw agent id.
  assert.equal(messages.get(queued.resultMessageId)?.content, "监督者（supervisor） queued...");

  manager.cancel(queued.id);
  assert.match(
    messages.get(queued.resultMessageId)?.content ?? "",
    /监督者（supervisor） 排队任务已取消。/,
  );

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("run lifecycle content and activity do not leak the raw 'run' codeword", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  // Only runs that actually start consume a deferred; a queued-then-cancelled
  // run never calls send(), so we queue deferreds in start order.
  const interrupted = deferred(); // run1: interrupted, promise abandoned
  const completed = deferred();   // run3: completes
  const failing = deferred();     // run4: fails
  const sendQueue = [interrupted, completed, failing];
  const liveActivities: AgentActivityEvent[] = [];
  eventBus.subscribe((event: RuntimeEvent) => {
    if (event.type === "run.activity") liveActivities.push(event.activity);
  });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return sendQueue.shift()!.promise; },
          interrupt() { return true; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
    getAgentLabel: () => "开发（developer）",
  });

  const source = createSourceMessage();
  const running = manager.enqueue("developer", "first", source);  // running
  const queued = manager.enqueue("developer", "second", source);  // queued behind running
  manager.cancel(queued.id);                                      // cancel before start
  manager.cancel(running.id);                                     // interrupt running run
  interrupted.reject(new AgentRunCancelledError("cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.enqueue("developer", "third", source);                 // running again
  completed.resolve({ content: "third done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.enqueue("developer", "fourth", source);                 // running again
  failing.reject(new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Scan every persisted message's content plus the live status/error activity
  // stream — both surfaces carry user-visible lifecycle text today.
  const collected: string[] = [];
  for (const message of messages.list()) {
    collected.push(message.content ?? "");
    for (const activity of message.activity ?? []) {
      if (activity.type === "status") collected.push(activity.text);
      else if (activity.type === "error") collected.push(activity.message);
    }
  }
  for (const activity of liveActivities) {
    if (activity.type === "status") collected.push(activity.text);
    else if (activity.type === "error") collected.push(activity.message);
  }
  const joined = collected.join("\n");
  assert.equal(/\brun\b/i.test(joined), false, `expected no bare 'run' codeword in lifecycle text, got: ${joined}`);
});

test("enqueue respects explicit origin parameter over sourceMessage kind", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return Promise.resolve({ content: "ok" }); }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const userMsg: ChatMessage = { id: "u1", kind: "user", content: "hello", createdAt: new Date().toISOString(), status: "sent" };

  // Explicit origin should override the inferred one
  const run = manager.enqueue("developer", "work", userMsg, "supervisor");
  assert.equal(run.origin, "supervisor");
});

test("supervisor-origin run records a low route-depth base instead of inheriting the trigger's depth", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return new Promise<RunResult>(() => {}); }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  // ChannelWatchService passes the real triggering message (here a deep agent
  // result at routeDepth 9) to enqueue(), not a synthetic depth-0 system message.
  const deepTrigger: ChatMessage = {
    id: "deep-trigger",
    kind: "agent",
    agentId: "developer",
    content: "deep result with no further @agent: assignment",
    createdAt: new Date().toISOString(),
    status: "done",
    routeDepth: 9,
  };

  const run = manager.enqueue("supervisor", "coordinate", deepTrigger, "supervisor");
  const supervisorMessage = messages.get(run.resultMessageId);

  // Before the fix this inherited 9 + 1 = 10, leaving no depth budget for the
  // supervisor's own @agent: assignments and tripping maxRouteDepth(10) early.
  // Supervisor runs are rate-limited by ChannelWatchService (maxTriggers), so a
  // fresh low base is safe and matches the pre-change synthetic-message behavior.
  assert.equal(supervisorMessage?.routeDepth, 1, "supervisor run must start from a low depth base");
});

test("supervisor-triggered runs keep their source message in conversation history", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const sourceMessageIds: Array<string | undefined> = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return new Promise<RunResult>(() => {}); }, interrupt() { return true; } }; },
    },
    buildPrompt(_agentId, prompt, sourceMessageId) {
      sourceMessageIds.push(sourceMessageId);
      return prompt;
    },
    onRunCompleted() {},
  });

  const architectResult: ChatMessage = {
    id: "architect-result",
    kind: "agent",
    agentId: "architect",
    content: "统计结果已经完成",
    createdAt: new Date().toISOString(),
    status: "done",
    runStatus: "completed",
    runId: "architect-run",
    completedAt: new Date().toISOString(),
  };

  manager.enqueue("supervisor", "Review the latest result", architectResult, "supervisor");

  assert.deepEqual(sourceMessageIds, [undefined]);
  manager.dispose();
});
