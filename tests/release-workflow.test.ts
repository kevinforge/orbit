import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

test("release workflow only starts from semantic version tags", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*- "v\*\.\*\.\*"/);
  assert.match(workflow, /node scripts\/verify-release-tag\.mjs/);
  assert.match(workflow, /git fetch origin main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git rev-list -n 1 "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
});

test("release workflow verifies, creates an npm package for every supported target, then publishes", () => {
  assert.match(workflow, /platform: windows/);
  assert.match(workflow, /platform: linux/);
  assert.match(workflow, /platform: macos\s/);
  assert.match(workflow, /platform: macosArm/);
  assert.match(workflow, /runner: windows-latest/);
  assert.match(workflow, /runner: ubuntu-latest/);
  assert.match(workflow, /runner: macos-15-intel/);
  assert.match(workflow, /runner: macos-15/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflow, /Smoke test standalone binary/);
  assert.match(workflow, /\.\/dist\/bin\/\$\{\{ matrix\.binary \}\}.*--machine-id/);
  assert.match(workflow, /rm -rf dist/);
  assert.match(workflow, /Unexpected file in release package/);
  assert.match(workflow, /package\/dist\/bin\/"\$\{BINARY\}"/);
  assert.match(workflow, /package\/dist\/ui\/\*/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /npm pack --pack-destination release --silent/);
  assert.match(workflow, /release\/orbit-\$\{version\}-\$\{ASSET\}\.tgz/);
  assert.doesNotMatch(workflow, /\.zip"/);
  assert.doesNotMatch(workflow, /\.tar\.gz"/);
});

test("release tag verifier accepts the package version and rejects mismatches", () => {
  const verifier = path.join(root, "scripts/verify-release-tag.mjs");
  const valid = spawnSync(process.execPath, [verifier, `v${packageJson.version}`], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync(process.execPath, [verifier, "v999.0.0"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match package\.json version/);
});
