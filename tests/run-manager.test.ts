import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../src/core/event-bus.ts";
import { MessageStore } from "../src/core/message-store.ts";
import { classifyTerminalActivities, classifyTerminalActivity, RunManager } from "../src/core/run-manager.ts";
import type { AgentId, ChatMessage, RunResult } from "../src/shared/types.ts";

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

test("terminal chunks append visible activity to the running message", async () => {
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

  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: "Running Bash(command)" });
  const runningMessage = messages.get(run.resultMessageId);
  assert.ok(runningMessage?.activity?.some((activity) => activity.type === "tool.started" && activity.name === "Bash"));

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));
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
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split tool_use test", createSourceMessage());

  const fullJson = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/main.ts" } }] },
  });
  const mid = Math.floor(fullJson.length / 2);
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: fullJson.slice(0, mid) });
  eventBus.publish({ type: "terminal.chunk", conversationId: "test-conv", agentId: "developer", runId: activeRunId, text: fullJson.slice(mid) });

  const msg = messages.get(run.resultMessageId);
  const toolStarted = msg?.activity?.find((a) => a.type === "tool.started");
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
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split result test", createSourceMessage());

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

  const msg = messages.get(run.resultMessageId);
  const toolCompleted = msg?.activity?.find((a) => a.type === "tool.completed");
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
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split failed result test", createSourceMessage());

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

  const msg = messages.get(run.resultMessageId);
  const toolFailed = msg?.activity?.find((a) => a.type === "tool.failed");
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
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "split codex test", createSourceMessage());

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

  const msg = messages.get(run.resultMessageId);
  const toolCompleted = msg?.activity?.find((a) => a.type === "tool.completed");
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
  assert.ok(cancelledMsg?.content.includes("cancelled"));

  // Complete the active run — cancelled queued run should NOT start
  first.resolve({ content: "first done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, "cancelled queued run should not start");
});

test("cancel a running run returns already_running error", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return first.promise; },
        };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  const result = manager.cancel(run.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "already_running");
  assert.equal(run.status, "running", "run status must not change");

  // Run should complete normally
  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const msg = messages.get(run.resultMessageId);
  assert.equal(msg?.status, "done");
});

test("cancel a non-existent run returns not_found error", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return Promise.resolve({ content: "ok" }); } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const result = manager.cancel("nonexistent-run");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_found");
});

test("cancel an already-completed run returns not_cancellable", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; } }; },
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
      get() { return { send() { return pending[callIdx++]!.promise; } }; },
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

  const cancelledEvents = events.filter((e) => e.type === "run.cancelled");
  assert.equal(cancelledEvents.length, 1, "should publish one run.cancelled event");
});

test("cancel a running run does not publish a run.cancelled event", async () => {
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
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  const result = manager.cancel(run.id);
  assert.equal(result.reason, "already_running");

  const cancelledEvents = events.filter((e) => e.type === "run.cancelled");
  assert.equal(cancelledEvents.length, 0, "running runs should not publish run.cancelled");
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
        };
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const run = manager.enqueue("developer", "first", createSourceMessage());
  const rawEvent = JSON.stringify({ type: "system", subtype: "hook_started", hook_id: "x".repeat(5_000) });
  failure.reject(new Error(rawEvent.repeat(100)));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failed = messages.get(run.resultMessageId);
  assert.equal(failed?.status, "error");
  assert.ok((failed?.content.length ?? 0) < 2_100, `content was too long: ${failed?.content.length}`);
  assert.ok(!failed?.content.includes("hook_id\":\"" + "x".repeat(100)), "raw JSON should not be persisted in content");

  const lastActivity = failed?.activity?.at(-1);
  assert.equal(lastActivity?.type, "status");
  assert.ok(lastActivity?.type === "status" && lastActivity.text.length < 2_100);
});

// ---------------------------------------------------------------------------
// interruptCurrentChain tests
// ---------------------------------------------------------------------------

test("interruptCurrentChain cancels all queued runs", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const pending = [first, deferred(), deferred()];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send() { return pending.shift()?.promise ?? Promise.reject(new Error("unexpected")); } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  // All three for the same agent: first runs, second and third are queued
  manager.enqueue("developer", "first", source);
  const queued1 = manager.enqueue("developer", "second", source);
  const queued2 = manager.enqueue("developer", "third", source);

  assert.equal(queued1.status, "queued");
  assert.equal(queued2.status, "queued");

  const result = manager.interruptCurrentChain();
  assert.equal(result.cancelledQueuedRunIds.length, 2);
  assert.ok(result.cancelledQueuedRunIds.includes(queued1.id));
  assert.ok(result.cancelledQueuedRunIds.includes(queued2.id));

  // Verify queued messages are cancelled
  assert.equal(messages.get(queued1.resultMessageId)?.runStatus, "cancelled");
  assert.equal(messages.get(queued2.resultMessageId)?.runStatus, "cancelled");
});

test("interruptCurrentChain marks running runs with suppressFollowupRouting", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();

  // agent1's run is running, agent2's run is also running (different agents)
  const pending = new Map<string, Deferred>();
  pending.set("run_agent1", first);
  pending.set("run_agent2", second);

  let runCount = 0;
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send(runId: string) { runCount++; return pending.get(runId)?.promise ?? Promise.reject(new Error("unexpected")); } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run1 = manager.enqueue("agent1", "task1", source);
  const run2 = manager.enqueue("agent2", "task2", source);

  assert.equal(run1.status, "running");
  assert.equal(run2.status, "running");
  assert.equal(runCount, 2);

  const result = manager.interruptCurrentChain();
  assert.equal(result.suppressedRunningRunIds.length, 2);
  assert.ok(result.suppressedRunningRunIds.includes(run1.id));
  assert.ok(result.suppressedRunningRunIds.includes(run2.id));
});

test("interruptCurrentChain returns empty arrays when no runs exist", () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return Promise.resolve({ content: "ok" }); } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const result = manager.interruptCurrentChain();
  assert.deepEqual(result.cancelledQueuedRunIds, []);
  assert.deepEqual(result.suppressedRunningRunIds, []);
});

test("interruptCurrentChain is idempotent — second call returns empty", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "task", source);
  const queued = manager.enqueue("developer", "queued-task", source);

  // First interrupt — cancels queued, suppresses running
  const result1 = manager.interruptCurrentChain();
  assert.equal(result1.suppressedRunningRunIds.length, 1);
  assert.equal(result1.cancelledQueuedRunIds.length, 1);

  // Second interrupt — nothing new to suppress or cancel
  const result2 = manager.interruptCurrentChain();
  assert.deepEqual(result2.cancelledQueuedRunIds, []);
  assert.deepEqual(result2.suppressedRunningRunIds, []);
});

// ---------------------------------------------------------------------------
// Suppressed run completion behavior tests
// ---------------------------------------------------------------------------

test("suppressed run completes — message updates but onRunCompleted is NOT called", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let onRunCompletedCalls = 0;

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() { onRunCompletedCalls++; },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  // Interrupt → suppress the running run
  manager.interruptCurrentChain();

  // Complete the suppressed run
  first.resolve({ content: "suppressed result" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Message should still be updated with content
  const updated = messages.get(run.resultMessageId);
  assert.equal(updated?.status, "done");
  assert.equal(updated?.content, "suppressed result");

  // onRunCompleted should NOT be called for suppressed run
  assert.equal(onRunCompletedCalls, 0, "onRunCompleted must not be called for suppressed run");
});

test("suppressed run does not publish run.completed event", async () => {
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
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "work", source);
  manager.interruptCurrentChain();

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completedEvents = events.filter((e) => e.type === "run.completed");
  assert.equal(completedEvents.length, 0, "suppressed run must not publish run.completed");
});

test("suppressed run still starts next queued task via startNext", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const calls: string[] = [];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return { send(runId: string) { calls.push(runId); return pending.shift()?.promise ?? Promise.reject(new Error("unexpected")); } };
      },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run1 = manager.enqueue("developer", "first-task", source);
  const run2 = manager.enqueue("developer", "second-task", source);

  assert.equal(run2.status, "queued");
  // Interrupt → run1 suppressed
  manager.interruptCurrentChain();
  assert.equal(run2.status, "cancelled", "queued task should be cancelled by interrupt");

  // Actually let's test with a scenario where a NEW task is enqueued AFTER interrupt
  // That new task should run after the suppressed one completes
  const run3 = manager.enqueue("developer", "post-interrupt-task", source);
  // run3 is queued because run1 is still running

  first.resolve({ content: "suppressed done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // run3 should now start (startNext was called even though run1 was suppressed)
  assert.equal(run3.status, "running", "post-interrupt task should start after suppressed run completes");
  assert.ok(calls.includes(run3.id), "startNext should start the next queued task");
});

test("non-suppressed run still calls onRunCompleted (regression)", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let onRunCompletedCalls = 0;

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() { onRunCompletedCalls++; },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  // No interrupt — normal flow

  first.resolve({ content: "normal done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(onRunCompletedCalls, 1, "onRunCompleted must be called for non-suppressed run");
  assert.equal(messages.get(run.resultMessageId)?.status, "done");
});

test("non-suppressed run publishes run.completed event (regression)", async () => {
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
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  manager.enqueue("developer", "work", source);

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const completedEvents = events.filter((e) => e.type === "run.completed");
  assert.equal(completedEvents.length, 1, "non-suppressed run must publish run.completed");
});

test("suppressed run fail also skips onRunCompleted and run events", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let onRunCompletedCalls = 0;
  const events: Array<{ type: string }> = [];

  eventBus.subscribe((event) => { events.push(event as { type: string }); });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return first.promise; } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() { onRunCompletedCalls++; },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  manager.interruptCurrentChain();

  first.reject(new Error("runtime error"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Message should still be updated with error
  const updated = messages.get(run.resultMessageId);
  assert.equal(updated?.status, "error");

  // onRunCompleted should NOT be called
  assert.equal(onRunCompletedCalls, 0, "onRunCompleted must not be called for suppressed failed run");

  // run.failed event should NOT be published
  const failedEvents = events.filter((e) => e.type === "run.failed");
  assert.equal(failedEvents.length, 0, "suppressed run must not publish run.failed");
});

test("interruptCurrentChain handles mixed queued and running runs across agents", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const agent1Deferred = deferred();
  const agent2Deferred = deferred();
  const pending = [agent1Deferred, agent2Deferred];

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() { return { send() { return pending.shift()?.promise ?? Promise.reject(new Error("unexpected")); } }; },
    },
    buildPrompt(_agentId, prompt) { return prompt; },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run1 = manager.enqueue("agent1", "task1", source);  // running
  const run2 = manager.enqueue("agent2", "task2", source);  // running (different agent)
  const run3 = manager.enqueue("agent1", "task3", source);  // queued behind run1
  const run4 = manager.enqueue("agent2", "task4", source);  // queued behind run2

  assert.equal(run1.status, "running");
  assert.equal(run2.status, "running");
  assert.equal(run3.status, "queued");
  assert.equal(run4.status, "queued");

  const result = manager.interruptCurrentChain();

  assert.deepEqual(result.suppressedRunningRunIds.sort(), [run1.id, run2.id].sort());
  assert.deepEqual(result.cancelledQueuedRunIds.sort(), [run3.id, run4.id].sort());
});
