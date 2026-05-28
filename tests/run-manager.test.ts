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

  eventBus.publish({ type: "terminal.chunk", agentId: "developer", runId: activeRunId, text: "Running Bash(command)" });
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
  assert.equal(activities[1]?.type === "tool.completed" ? activities[1].summary : "", "/d/projects/orbit");
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
  assert.equal(
    activities[1]?.type === "tool.completed" ? activities[1].summary : "",
    "## fix/issue-14-activity-tool-visibility",
  );
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

test("run failures store a concise error instead of raw stream output", async () => {
  const messages = new MessageStore();
  const eventBus = new EventBus();
  const failure = deferred();

  const manager = new RunManager({
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
