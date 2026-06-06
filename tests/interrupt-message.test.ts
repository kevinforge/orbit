import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { INTERRUPT_SYSTEM_MESSAGE } from "../src/server/conversation-context.ts";

/**
 * Issue #70: The interrupt system message should not expose internal
 * implementation terms like "run", "supervisor 自动触发" to the user.
 */
describe("interrupt system message", () => {
  test("is concise and user-friendly", () => {
    // Must be short (under 30 chars)
    assert.ok(
      INTERRUPT_SYSTEM_MESSAGE.length <= 30,
      `System message should be concise, got ${INTERRUPT_SYSTEM_MESSAGE.length} chars: "${INTERRUPT_SYSTEM_MESSAGE}"`,
    );
  });

  test("does not contain internal implementation terms", () => {
    const forbiddenTerms = [
      "run",
      "supervisor",
      "自动触发",
      "数字员工",
      "协作链",
      "指派",
    ];

    for (const term of forbiddenTerms) {
      assert.ok(
        !INTERRUPT_SYSTEM_MESSAGE.includes(term),
        `System message must not contain internal term "${term}", got: "${INTERRUPT_SYSTEM_MESSAGE}"`,
      );
    }
  });
});
