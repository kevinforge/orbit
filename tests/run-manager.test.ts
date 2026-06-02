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

function mockAgents(send: (agentId: string, runId: string, prompt: string) => Promise<RunResult>) {
  return {
    get(_agentId: string) {
      return {
        send(runId: string, prompt: string) {
          return send(_agentId, runId, prompt);
        },
      };
    },
    interrupt() {},
  };
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
      interrupt() {},
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
      interrupt() {},
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
      interrupt() {},
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
      interrupt() {},
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
      interrupt() {},
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
      interrupt() {},
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
  let interruptCalled = false;

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
      interrupt() {
        interruptCalled = true;
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
  const cancelled = manager.cancel(queued.id);
  assert.ok(cancelled, "cancel should return true for queued run");
  assert.equal(interruptCalled, false, "interrupt should not be called for queued runs");

  const cancelledMsg = messages.get(queued.resultMessageId);
  assert.equal(cancelledMsg?.status, "cancelled");
  assert.ok(cancelledMsg?.content.includes("cancelled"));

  // Complete the active run — queued should NOT start
  first.resolve({ content: "first done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1, "cancelled queued run should not start");
  assert.equal(interruptCalled, false);
});

test("cancel a running run calls interrupt on the agent", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let interruptCalled = false;

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return first.promise;
          },
        };
      },
      interrupt() {
        interruptCalled = true;
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  assert.equal(run.status, "running");

  const cancelled = manager.cancel(run.id);
  assert.ok(cancelled, "cancel should return true for running run");
  assert.equal(interruptCalled, true, "interrupt should be called for running runs");

  const cancelledMsg = messages.get(run.resultMessageId);
  assert.equal(cancelledMsg?.status, "cancelled");

  // Resolve the run — it should not fire onRunCompleted
  first.resolve({ content: "done anyway" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Message should stay cancelled, not overwritten to "done"
  const final = messages.get(run.resultMessageId);
  assert.equal(final?.status, "cancelled");
});

test("cancel a running run advances the queue so the next queued run starts", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  let interruptCalled = false;

  const calls: Array<{ agentId: AgentId; runId: string }> = [];
  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get(agentId: AgentId) {
        return {
          send(runId: string) {
            calls.push({ agentId, runId });
            return pending.shift()!.promise;
          },
        };
      },
      interrupt() {
        interruptCalled = true;
      },
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run1 = manager.enqueue("developer", "first", source);
  const run2 = manager.enqueue("developer", "second", source);

  assert.equal(run1.status, "running");
  assert.equal(run2.status, "queued");
  assert.equal(calls.length, 1, "only first run should start");

  // Cancel the running run
  manager.cancel(run1.id);
  assert.equal(interruptCalled, true);

  // The queued run should have started
  assert.equal(calls.length, 2, "second run should start after cancel");
  assert.equal(calls[1]!.runId, run2.id);

  // Verify message states
  const msg1 = messages.get(run1.resultMessageId);
  assert.equal(msg1?.status, "cancelled");

  // Complete the second run
  second.resolve({ content: "second done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const msg2 = messages.get(run2.resultMessageId);
  assert.equal(msg2?.status, "done");

  // Now resolve the cancelled first run — it should NOT overwrite status
  first.resolve({ content: "first done anyway" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.get(run1.resultMessageId)?.status, "cancelled",
    "cancelled status should survive late resolve");

  // And rejecting the cancelled run should also not overwrite
  const firstMsg = messages.get(run1.resultMessageId);
  assert.equal(calls.length, 2, "no extra runs should start from stale resolve");
});

test("cancel a non-existent run returns false", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() { return Promise.resolve({ content: "ok" }); },
        };
      },
      interrupt() {},
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  assert.equal(manager.cancel("nonexistent-run"), false);
});

test("onRunCompleted is not called for cancelled runs", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  let completedCount = 0;

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return first.promise;
          },
        };
      },
      interrupt() {},
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {
      completedCount++;
    },
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  manager.cancel(run.id);

  first.resolve({ content: "done" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(completedCount, 0, "onRunCompleted should not fire for cancelled runs");
});

test("cancel publishes a run.cancelled event", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const first = deferred();
  const events: Array<{ type: string; runId: string }> = [];

  eventBus.subscribe((event) => {
    if (event.type === "run.cancelled") {
      events.push(event as { type: string; runId: string });
    }
  });

  const manager = new RunManager({
    conversationId: "test-conv",
    messages,
    eventBus,
    agents: {
      get() {
        return {
          send() {
            return first.promise;
          },
        };
      },
      interrupt() {},
    },
    buildPrompt(_agentId, prompt) {
      return prompt;
    },
    onRunCompleted() {},
  });

  const source = createSourceMessage();
  const run = manager.enqueue("developer", "work", source);
  manager.cancel(run.id);

  assert.equal(events.length, 1, "should publish one run.cancelled event");
  assert.equal(events[0]!.runId, run.id);
  assert.equal(events[0]!.type, "run.cancelled");
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
      interrupt() {},
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
