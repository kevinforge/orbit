import assert from "node:assert/strict";
import test from "node:test";

import {
  AcpRunnerRegistry,
  defaultAcpRunnerRegistry,
  type AcpRunnerRegistration,
} from "../src/core/acp-runner-registry.ts";

test("default ACP runner registry is the single source for all built-in runtimes", () => {
  assert.deepEqual(
    defaultAcpRunnerRegistry.list().map((registration) => registration.kind),
    ["claude-code", "codex", "codebuddy"],
  );
  assert.equal(defaultAcpRunnerRegistry.runtimeMap().get("codex")?.kind, "codex");
});

test("ACP runner registry rejects mismatched and duplicate registrations", () => {
  const registration = defaultAcpRunnerRegistry.get("codex")!;
  const registry = new AcpRunnerRegistry([registration]);
  assert.throws(() => registry.register(registration), /already registered/);

  const mismatch = {
    ...registration,
    kind: "codebuddy",
  } satisfies AcpRunnerRegistration;
  assert.throws(() => new AcpRunnerRegistry([mismatch]), /kind mismatch/);
});
