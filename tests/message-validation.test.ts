import test from "node:test";
import assert from "node:assert/strict";

import { canSendMessage } from "../src/shared/message-validation.ts";

test("message text alone is sendable", () => {
  assert.equal(canSendMessage("hello", 0), true);
});

test("attachments alone are sendable", () => {
  assert.equal(canSendMessage("", 1), true);
  assert.equal(canSendMessage("   ", 2), true);
});

test("empty text and no attachments are not sendable", () => {
  assert.equal(canSendMessage("", 0), false);
  assert.equal(canSendMessage("  ", 0), false);
});

test("negative attachment counts do not make an empty message sendable", () => {
  assert.equal(canSendMessage("", -1), false);
});
