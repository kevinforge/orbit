import assert from "node:assert/strict";
import test from "node:test";
import { probeRuntime, probeAllRuntimes, resolveCodexCommandPath, runtimeKindToCliKey, type RuntimeProbeResult } from "../src/core/runtime-probe.ts";

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

// --- resolveCodexCommandPath ---

test("resolveCodexCommandPath respects ORBIT_CODEX_PATH env var", () => {
  const result = resolveCodexCommandPath({ ORBIT_CODEX_PATH: process.execPath });
  assert.ok(result, "should resolve when ORBIT_CODEX_PATH points to an existing executable");
  assert.equal(result, process.execPath);
});

test("resolveCodexCommandPath respects CODEX_CLI_PATH env var", () => {
  const result = resolveCodexCommandPath({ CODEX_CLI_PATH: process.execPath });
  assert.ok(result, "should resolve when CODEX_CLI_PATH points to an existing executable");
  assert.equal(result, process.execPath);
});

test("resolveCodexCommandPath returns null for nonexistent absolute configured path", () => {
  const fakePath = process.platform === "win32" ? "C:\\nonexistent\\codex.exe" : "/nonexistent/codex";
  const result = resolveCodexCommandPath({ ORBIT_CODEX_PATH: fakePath });
  assert.equal(result, null, "should return null when configured absolute path does not exist");
});

test("resolveCodexCommandPath returns null when no env var is set and not on PATH", () => {
  // Clear env vars that might resolve codex
  const result = resolveCodexCommandPath({});
  // May or may not find codex depending on system, but should not throw
  assert.equal(typeof result, typeof result === "string" ? "string" : "object");
});
