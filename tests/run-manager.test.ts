import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../src/core/event-bus.ts";
import { MessageStore } from "../src/core/message-store.ts";
import { classifyTerminalActivities, classifyTerminalActivity, RunManager } from "../src/core/run-manager.ts";
import type { AgentId, ChatMessage } from "../src/shared/types.ts";

type Deferred = {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
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

  first.resolve("first done");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.prompt, "context\nsecond");

  second.resolve("second done");
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

  first.resolve("done");
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
