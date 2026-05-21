import test from "node:test";
import assert from "node:assert/strict";

import { QuietWindowTurnDetector } from "../src/core/turn-detector.ts";

test("is quiet only after the configured quiet window has elapsed", () => {
  const detector = new QuietWindowTurnDetector(1_000);
  detector.markOutput(10_000);

  assert.equal(detector.isQuiet(10_999), false);
  assert.equal(detector.isQuiet(11_000), true);
});

test("supports the P0 default design expectation of 180000ms", () => {
  const detector = new QuietWindowTurnDetector(180_000);
  detector.markOutput(0);

  assert.equal(detector.isQuiet(179_999), false);
  assert.equal(detector.isQuiet(180_000), true);
});

test("a detector without output is not quiet", () => {
  const detector = new QuietWindowTurnDetector(1_000);

  assert.equal(detector.isQuiet(10_000), false);
});
