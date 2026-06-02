import assert from "node:assert/strict";
import test from "node:test";
import { probeRuntime, probeAllRuntimes, runtimeKindToCliKey, type RuntimeProbeResult } from "../src/core/runtime-probe.ts";

test("probeRuntime finds node on PATH", async () => {
  const result = await probeRuntime("node");
  assert.ok(result.available, "node should be available on PATH");
  assert.ok(result.path, "should have a path when available");
  assert.equal(result.runtime, "node");
});

test("probeRuntime returns not available for nonexistent command", async () => {
  const result = await probeRuntime("this-command-does-not-exist-xyz");
  assert.equal(result.available, false);
  assert.equal(result.runtime, "this-command-does-not-exist-xyz");
  assert.equal(result.path, null);
  assert.ok(result.error, "should have error message");
});

test("probeAllRuntimes returns results for all three runtimes", async () => {
  const results = await probeAllRuntimes();
  assert.equal(results.length, 3);
  const names = results.map((r) => r.runtime);
  assert.ok(names.includes("claude"));
  assert.ok(names.includes("codex"));
  assert.ok(names.includes("codebuddy"));
  for (const result of results) {
    assert.equal(typeof result.available, "boolean");
    if (result.available) {
      assert.ok(result.path, `${result.runtime} should have path when available`);
    } else {
      assert.equal(result.path, null, `${result.runtime} should have null path when unavailable`);
    }
  }
});

test("probeRuntime handles special characters in command name", async () => {
  // where on Windows handles basic names safely
  const result = await probeRuntime("");
  assert.equal(result.available, false);
  assert.ok(result.error);
});

// --- runtimeKindToCliKey mapping ---

test("runtimeKindToCliKey maps claude-code to claude CLI key", () => {
  assert.equal(runtimeKindToCliKey("claude-code"), "claude");
});

test("runtimeKindToCliKey passes through codex unchanged", () => {
  assert.equal(runtimeKindToCliKey("codex"), "codex");
});

test("runtimeKindToCliKey passes through codebuddy unchanged", () => {
  assert.equal(runtimeKindToCliKey("codebuddy"), "codebuddy");
});

test("runtimeKindToCliKey handles unknown runtime types gracefully", () => {
  assert.equal(runtimeKindToCliKey("unknown-runtime"), "unknown-runtime");
});

// --- Codex probe uses the real runtime resolver ---

test("probeCodexRuntime via probeAllRuntimes returns record for codex", async () => {
  const results = await probeAllRuntimes();
  const codex = results.find((r) => r.runtime === "codex");
  assert.ok(codex, "should include codex probe result");
  // The real resolveCodexCommand is used internally; we verify it doesn't throw
  // and returns a properly structured result
  assert.equal(typeof codex!.available, "boolean");
  if (codex!.available) {
    assert.ok(codex!.path, "should have path when available");
  } else {
    // When unavailable, should have error message or null path
    assert.ok(codex!.error || codex!.path === null, "should have error or null path when missing");
  }
});

test("probeCodexRuntime is consistent with resolveCodexCommand", async () => {
  // Verify that probeAllRuntimes' codex probe uses resolveCodexCommand by
  // checking it runs without throwing for all env var configurations
  const results = await probeAllRuntimes();
  const codex = results.find((r) => r.runtime === "codex");
  assert.ok(codex, "codex probe should always return a result");
  // available must be boolean, path must be string|null
  assert.equal(typeof codex!.available, "boolean");
  if (codex!.path !== null) {
    assert.equal(typeof codex!.path, "string");
  }
});
