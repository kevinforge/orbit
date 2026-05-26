import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdown } from "../src/ui/markdown-renderer.ts";

test("parses fenced code block with language tag", () => {
  const blocks = parseMarkdown("```ts\nconsole.log(\"hello\");\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code_block");
  assert.equal(blocks[0].lang, "ts");
  assert.equal(blocks[0].code, 'console.log("hello");');
});

test("parses fenced code block without language tag", () => {
  const blocks = parseMarkdown("```\nsome code\nmore code\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code_block");
  assert.equal(blocks[0].lang, undefined);
  assert.equal(blocks[0].code, "some code\nmore code");
});

test("parses fenced code block between paragraphs", () => {
  const blocks = parseMarkdown("intro\n```js\ncode\n```\n outro");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[1].type, "code_block");
  assert.equal(blocks[1].lang, "js");
  assert.equal(blocks[2].type, "paragraph");
});

test("parses horizontal rule with dashes", () => {
  const blocks = parseMarkdown("---");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "hr");
});

test("parses horizontal rule with underscores", () => {
  const blocks = parseMarkdown("___");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "hr");
});

test("parses horizontal rule with asterisks", () => {
  const blocks = parseMarkdown("***");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "hr");
});

test("does not treat list items as horizontal rule", () => {
  const blocks = parseMarkdown("- item");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "list");
});

test("parses hr between content", () => {
  const blocks = parseMarkdown("above\n---\nbelow");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[1].type, "hr");
  assert.equal(blocks[2].type, "paragraph");
});

test("handles unclosed fenced code block gracefully", () => {
  const blocks = parseMarkdown("```js\nconst x = 1;\nconst y = 2;");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code_block");
  assert.equal(blocks[0].lang, "js");
  assert.equal(blocks[0].code, "const x = 1;\nconst y = 2;");
});
