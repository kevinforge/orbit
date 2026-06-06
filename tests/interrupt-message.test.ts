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
    const tooltipMatch = appSource.match(/title="([^"]*停止[^"]*协作[^"]*)"/);
    assert.ok(tooltipMatch, "Interrupt button must have a tooltip containing '停止' and '协作'");

    const tooltip = tooltipMatch[1];
    const forbiddenTerms = ["run", "supervisor", "自动触发", "数字员工", "协作链", "指派"];
    for (const term of forbiddenTerms) {
      assert.ok(
        !tooltip.includes(term),
        `Tooltip must not contain internal term "${term}", got: "${tooltip}"`,
      );
    }
  });
});
