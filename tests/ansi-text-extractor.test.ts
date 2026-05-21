import test from "node:test";
import assert from "node:assert/strict";

import { extractReadableText, stripAnsi } from "../src/core/ansi-text-extractor.ts";

test("stripAnsi removes CSI, OSC, and carriage-return control output", () => {
  const raw = "\u001b[31mred\u001b[0m\u001b]0;title\u0007\rnext";

  assert.equal(stripAnsi(raw), "rednext");
});

test("extractReadableText keeps readable text and collapses excessive blank lines", () => {
  const raw = "\u001b[2J\n\n\n  你好 Orbit  \n\n\nDone\u001b[?25h";

  assert.equal(extractReadableText(raw), "你好 Orbit\n\nDone");
});
