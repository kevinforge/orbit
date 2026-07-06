import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const entry = fs.readFileSync(path.join(root, "src/standalone-entry.ts"), "utf8");

test("standalone entry does not require a license by default", () => {
  const gateIndex = entry.indexOf('process.env.ORBIT_REQUIRE_LICENSE === "true"');
  const validationIndex = entry.indexOf("validateLicenseAsync()");

  assert.ok(gateIndex >= 0, "license validation should be behind an explicit environment gate");
  assert.ok(validationIndex > gateIndex, "license validation should only appear inside the gated path");
});

test("standalone entry exposes a help smoke-test command", () => {
  assert.match(entry, /process\.argv\.includes\("--help"\)/);
  assert.match(entry, /Orbit - local-first collaboration workspace/);
});
