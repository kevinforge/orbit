import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Issue #70: Interrupting the auto-collaboration chain should NOT produce
 * a user-visible system message in the chat. Instead, a non-persistent
 * toast notification provides feedback to the user.
 */

const contextSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/server/conversation-context.ts"),
  "utf-8",
);

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

const stylesSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/styles.css"),
  "utf-8",
);

/** Extract the body of the interrupt() method from the class source. */
function extractMethodBody(source: string, methodName: string): string | null {
  const regex = new RegExp(`${methodName}\\([^)]*\\)[^{]*\\{`, "g");
  let match;
  while ((match = regex.exec(source)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    return source.slice(start, i - 1);
  }
  return null;
}

describe("interrupt produces no system message (#70)", () => {
  test("interrupt() does not add a system message to chat", () => {
    const body = extractMethodBody(contextSource, "interrupt");
    assert.ok(body, "Could not find interrupt() method in conversation-context.ts");

    assert.ok(
      !body.includes("messages.add"),
      "interrupt() must not add messages. Got body:\n" + body,
    );
    assert.ok(
      !body.includes("kind: \"system\""),
      "interrupt() must not create system messages. Got body:\n" + body,
    );
    assert.ok(
      !body.includes("message.created"),
      "interrupt() must not publish message.created events. Got body:\n" + body,
    );
  });

  test("interrupt button tooltip is user-friendly", () => {
    const tooltipMatch = appSource.match(/title="([^"]*停止[^"]*任务[^"]*)"/);
    assert.ok(tooltipMatch, "Interrupt button must have a tooltip containing '停止' and '任务'");

    const tooltip = tooltipMatch[1];
    const forbiddenTerms = ["run", "supervisor", "自动触发", "数字员工", "协作链", "指派"];
    for (const term of forbiddenTerms) {
      assert.ok(
        !tooltip.includes(term),
        `Tooltip must not contain internal term "${term}", got: "${tooltip}"`,
      );
    }
  });

  test("successful interrupt shows a non-persistent toast, not a chat message", () => {
    // Must have toast state
    assert.ok(
      appSource.includes("interruptToast"),
      "App must have interruptToast state for non-persistent feedback",
    );

    // Toast must auto-dismiss via setTimeout
    assert.ok(
      appSource.includes("setInterruptToast(null)"),
      "Toast must auto-dismiss after a timeout",
    );

    // Toast must be rendered in the UI
    assert.ok(
      appSource.includes("interruptToast"),
      "Toast must be rendered as a non-message UI element",
    );

    // Must NOT add to chat messages on success (catch block for errors is OK)
    const interruptTryBlock = appSource.match(/async function interruptChain\(\)[\s\S]*?try\s*\{([\s\S]*?)\}\s*catch/);
    assert.ok(interruptTryBlock, "Could not find interruptChain try block");
    assert.ok(
      !interruptTryBlock[1].includes("createLocalSystemMessage"),
      "interruptChain must not add local system messages on success path",
    );

    // Must have toast CSS
    assert.ok(
      stylesSource.includes("interruptToast"),
      "styles.css must have .interruptToast styles",
    );
  });
});

describe("stop button surfaces while internal supervisor is running", () => {
  test("hasRunningOrQueued accounts for messages with runStatus === 'running'", () => {
    // 修复：监工（internal）被 AgentRegistry.states() 过滤，state.agents 不含监工。
    // 新建会话第一条无 @ 消息只触发监工 → state.agents 全 idle、无 queued 消息，
    // 旧逻辑 hasRunningOrQueued=false → 不渲染停止按钮。修复后必须通过 messages 上的
    // runStatus==='running' 判定覆盖该场景。
    assert.ok(
      appSource.includes('m.runStatus === "running"'),
      "App.tsx must check messages' runStatus === 'running' when computing hasRunningOrQueued",
    );

    // 同时保留对 queued 的判断（不能丢）
    assert.ok(
      appSource.includes('m.runStatus === "queued"'),
      "App.tsx must still check messages' runStatus === 'queued'",
    );

    // hasRunningOrQueued 必须由 messages 上的 active run 计算（与 isAnyAgentRunning 取或）
    assert.ok(
      appSource.includes("hasRunningOrQueued"),
      "App.tsx must still expose hasRunningOrQueued for the interrupt button gating",
    );
  });
});
