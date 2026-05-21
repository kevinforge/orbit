import assert from "node:assert/strict";
import test from "node:test";

import {
  extractClaudeAssistantReply,
  hasClaudeTurnFinished,
  shouldCompleteFromTerminalOutput,
} from "../src/core/claude-output-detector.ts";

test("detects Claude TUI completion from brewed marker", () => {
  assert.equal(hasClaudeTurnFinished("Brewed for 12s\n\n>"), true);
});

test("does not treat thinking output as complete", () => {
  assert.equal(hasClaudeTurnFinished("* Brewing... (9s | 7 tokens | thinking)"), false);
});

test("waits for the stop hook instead of completing from Claude TUI markers", () => {
  const noisyHookOutput = "Ran 4 stop hooks (ctrl+o to expand) | Stophookerror: Failedwithnon-blockingstatuscode";
  const brewedOutput = "Brewed for 12s";

  assert.equal(shouldCompleteFromTerminalOutput(noisyHookOutput, false, true), false);
  assert.equal(shouldCompleteFromTerminalOutput(brewedOutput, false, true), false);
  assert.equal(shouldCompleteFromTerminalOutput(brewedOutput, true, true), true);
});

test("extracts assistant reply from noisy Claude TUI output", () => {
  const output = [
    "> hello",
    "* Brewing...",
    "7\u25cfHello. What can I help with? Brewing...",
    "Brewed for 12s",
  ].join("\n");

  assert.equal(extractClaudeAssistantReply(output), "Hello. What can I help with?");
});
