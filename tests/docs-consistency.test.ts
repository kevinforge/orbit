import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("CLAUDE.md documents the current multi-runtime architecture", () => {
  const doc = readRepoFile("CLAUDE.md");

  assert.match(doc, /CLI-backed digital employees/);
  assert.match(doc, /Codex, Claude Code, and CodeBuddy CLI/);
  assert.doesNotMatch(doc, /multiple Claude Code CLI agents/);
  assert.doesNotMatch(doc, /claude CLI \(stream-json\)/);
});

test("CLAUDE.md keeps routing and startup verification guidance current", () => {
  const doc = readRepoFile("CLAUDE.md");

  assert.match(doc, /npm run smoke:start/);
  assert.match(doc, /delegation chains capped at depth 10/);
  assert.doesNotMatch(doc, /delegation chains capped at depth 5/);
});

test("open source readiness no longer tracks completed Claude-only architecture cleanup", () => {
  const doc = readRepoFile("docs/OPEN_SOURCE_READINESS.md");

  assert.doesNotMatch(doc, /still imply Claude Code only/);
});
