import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Bug: When a brand-new conversation is active (the backend activates it on
 * creation), and the user switches to the "工作分析" (work analysis) view,
 * clicking that same active conversation in the sidebar does nothing — the view
 * stays on work analysis. The user must first click another conversation, then
 * click back. Root cause: `switchConversation()` early-returns when the clicked
 * conversation is already active, but `setActiveView("conversation")` lived
 * AFTER that guard, so the view never switched.
 *
 * This mirrors the source-scanning style used across this repo's UI tests
 * (e.g. interrupt-message.test.ts), since there is no React rendering harness.
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

/** Extract the body of a function/method by name (matches `name(...) {`). */
function extractFunctionBody(source: string, name: string): string | null {
  const regex = new RegExp(`${name}\\([^)]*\\)[^{]*\\{`, "g");
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

describe("switchConversation always returns to the conversation view", () => {
  test("setActiveView('conversation') runs before the active-conversation guard", () => {
    const body = extractFunctionBody(appSource, "switchConversation");
    assert.ok(body, "Could not find switchConversation() in App.tsx");

    // The early-return guard that short-circuits the /switch request when the
    // clicked conversation is already the active one.
    const guardIdx = body.indexOf(
      "if (conversationId === state.conversation.id)",
    );
    const viewIdx = body.indexOf('setActiveView("conversation")');

    assert.notStrictEqual(guardIdx, -1, "active-conversation guard should still exist");
    assert.notStrictEqual(viewIdx, -1, "setActiveView('conversation') must still be called");

    assert.ok(
      viewIdx < guardIdx,
      "setActiveView('conversation') must run BEFORE the active-conversation guard, " +
        "otherwise clicking the active conversation from another view (e.g. 工作分析) cannot return. " +
        "Got body:\n" + body,
    );
  });
});
