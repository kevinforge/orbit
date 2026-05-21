import assert from "node:assert/strict";
import test from "node:test";

import { routeMention } from "../src/core/mention-router.ts";

const agents = ["agent1", "agent2"] as const;

test("routes a single known mention and removes it from the prompt", () => {
  assert.deepEqual(routeMention("@agent1 总结这个项目", agents), {
    ok: true,
    agentId: "agent1",
    prompt: "总结这个项目",
  });
});

test("returns missing_mention when no agent is mentioned", () => {
  const result = routeMention("总结这个项目", agents);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_mention");
  assert.equal(result.message, "请使用 @agent1 或 @agent2 指定 Agent");
});

test("returns unknown_agent for unavailable mentions", () => {
  const result = routeMention("@agent3 总结这个项目", agents);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_agent");
  assert.equal(result.message, "未知 Agent：agent3。可用 Agent：@agent1、@agent2");
});

test("returns multiple_mentions when more than one agent is mentioned", () => {
  const result = routeMention("@agent1 和 @agent2 分别总结", agents);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "multiple_mentions");
  assert.equal(result.message, "一次只支持投递给一个 Agent");
});
