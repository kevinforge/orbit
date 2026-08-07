import assert from "node:assert/strict";
import test from "node:test";
import { probeRuntime, probeAllRuntimes, runtimeKindToCliKey, runtimeMeta, type RuntimeProbeResult } from "../src/core/runtime-probe.ts";

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
  assert.ok(names.includes("claude-agent-acp"));
  assert.ok(names.includes("codex-acp"));
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

test("runtimeKindToCliKey maps claude-code to the Claude ACP adapter", () => {
  assert.equal(runtimeKindToCliKey("claude-code"), "claude-agent-acp");
});

test("runtimeKindToCliKey maps codex to the Codex ACP adapter", () => {
  assert.equal(runtimeKindToCliKey("codex"), "codex-acp");
});

test("runtimeKindToCliKey passes through codebuddy unchanged", () => {
  assert.equal(runtimeKindToCliKey("codebuddy"), "codebuddy");
});

test("runtimeKindToCliKey handles unknown runtime types gracefully", () => {
  assert.equal(runtimeKindToCliKey("unknown-runtime"), "unknown-runtime");
});

// --- Codex probe uses the real runtime resolver ---

test("probeAllRuntimes returns a record for Codex ACP", async () => {
  const results = await probeAllRuntimes();
  const codex = results.find((r) => r.runtime === "codex-acp");
  assert.ok(codex, "should include codex probe result");
  // The adapter resolver is used internally; verify the result stays well formed.
  assert.equal(typeof codex!.available, "boolean");
  if (codex!.available) {
    assert.ok(codex!.path, "should have path when available");
  } else {
    // When unavailable, should have error message or null path
    assert.ok(codex!.error || codex!.path === null, "should have error or null path when missing");
  }
});

// --- runtimeMeta ---

test("runtimeMeta returns label and installUrl for claude-code", () => {
  const meta = runtimeMeta("claude-code");
  assert.equal(meta.label, "Claude Code");
  assert.ok(meta.installUrl.includes("claude-agent-acp"), "should have Claude ACP install URL");
  assert.ok(meta.installCommand.includes("@agentclientprotocol/claude-agent-acp"), "should include Claude ACP install command");
});

test("runtimeMeta returns label and installUrl for codex", () => {
  const meta = runtimeMeta("codex");
  assert.equal(meta.label, "OpenAI Codex");
  assert.ok(meta.installUrl.includes("codex-acp"), "should have Codex ACP install URL");
  assert.ok(meta.installCommand.includes("@openai/codex"), "should include Codex CLI install command");
  assert.ok(meta.installCommand.includes("@agentclientprotocol/codex-acp"), "should include Codex ACP install command");
});

test("runtimeMeta returns label and installUrl for codebuddy", () => {
  const meta = runtimeMeta("codebuddy");
  assert.equal(meta.label, "CodeBuddy");
  assert.ok(meta.installUrl.includes("codebuddy"), "should have codebuddy install URL");
  assert.ok(meta.installCommand.includes("@tencent-ai/codebuddy-code"), "should include CodeBuddy install command");
});

test("runtimeMeta returns runtime name as label for unknown runtime", () => {
  const meta = runtimeMeta("unknown");
  assert.equal(meta.label, "unknown");
  assert.equal(meta.installUrl, "");
  assert.equal(meta.installCommand, "");
});

test("Codex probe always returns runtime: codex-acp with a custom adapter path", async () => {
  const prevCliPath = process.env.CODEX_ACP_PATH;
  try {
    process.env.CODEX_ACP_PATH = "node";
    const results = await probeAllRuntimes();
    const codex = results.find((r) => r.runtime === "codex-acp");
    assert.ok(codex, "should find result with runtime: codex-acp even with a custom path");
    assert.equal(codex!.available, true);
    // path should reflect the actual resolved command
    assert.ok(codex!.path, "should have a resolved path");
  } finally {
    if (prevCliPath !== undefined) {
      process.env.CODEX_ACP_PATH = prevCliPath;
    } else {
      delete process.env.CODEX_ACP_PATH;
    }
  }
});

test("Codex ACP probe returns a stable availability record", async () => {
  const results = await probeAllRuntimes();
  const codex = results.find((r) => r.runtime === "codex-acp");
  assert.ok(codex, "codex probe should always return a result");
  // available must be boolean, path must be string|null
  assert.equal(typeof codex!.available, "boolean");
  if (codex!.path !== null) {
    assert.equal(typeof codex!.path, "string");
  }
});
