import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Issue #70: Interrupting the auto-collaboration chain should NOT produce
 * a user-visible system message in the chat. The button state change and
 * actual run cancellation provide sufficient feedback.
 */

const contextSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/server/conversation-context.ts"),
  "utf-8",
);

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
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
    // Both normal and post-interrupt tooltips should be free of internal terms
    const tooltipMatches = appSource.matchAll(/title=\{hasInterruptedCurrentChain \? "([^"]*)" : "([^"]*)"\}/g);
    for (const match of tooltipMatches) {
      const [_, postInterruptTooltip, normalTooltip] = match;
      const tooltips = [postInterruptTooltip, normalTooltip];
      const forbiddenTerms = ["run", "supervisor", "自动触发", "数字员工", "协作链", "指派"];

      for (const tooltip of tooltips) {
        for (const term of forbiddenTerms) {
          assert.ok(
            !tooltip.includes(term),
            `Tooltip must not contain internal term "${term}", got: "${tooltip}"`,
          );
        }
      }
    }
  });

  test("interrupt button has disabled state after successful interrupt", () => {
    assert.ok(
      appSource.includes("hasInterruptedCurrentChain"),
      "App must track hasInterruptedCurrentChain state",
    );

    // Button must be disabled when interrupted
    const disabledMatch = appSource.match(/disabled=\{isInterrupting \|\| ([^}]+)\}/);
    assert.ok(
      disabledMatch && disabledMatch[1].includes("hasInterruptedCurrentChain"),
      "Interrupt button must be disabled when hasInterruptedCurrentChain is true",
    );

    // Button text must change to "已打断"
    assert.ok(
      appSource.includes('hasInterruptedCurrentChain ? "已打断"'),
      "Button must show '已打断' after successful interrupt",
    );
  });

  test("interrupted state resets when no runs remain and on new message", () => {
    // useEffect reset when hasRunningOrQueued becomes false
    const useEffectPattern = /useEffect\(\(\) => \{[\s\S]*?if \(!hasRunningOrQueued && hasInterruptedCurrentChain\)/;
    assert.ok(
      useEffectPattern.test(appSource),
      "hasInterruptedCurrentChain must reset via useEffect when hasRunningOrQueued becomes false",
    );

    // Reset on new message send
    assert.ok(
      appSource.includes("setHasInterruptedCurrentChain(false)"),
      "hasInterruptedCurrentChain must reset when sending a new message",
    );
  });
});
