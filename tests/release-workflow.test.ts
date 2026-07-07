import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const standaloneBuilder = fs.readFileSync(path.join(root, "scripts/build-standalone.mjs"), "utf8");
const npmAssembler = fs.readFileSync(path.join(root, "scripts/assemble-npm-package.mjs"), "utf8");
const packageManifest = fs.readFileSync(path.join(root, "package.json"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const releaseTag = `v${packageJson.version}`;
const releaseTagPattern = releaseTag.replaceAll(".", "\\.");

test("release workflow only starts from semantic version tags", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*- "v\*\.\*\.\*"/);
  assert.match(workflow, /node scripts\/verify-release-tag\.mjs/);
  assert.match(workflow, /node scripts\/verify-release-readiness\.mjs "\$GITHUB_REF_NAME" --strict/);
  assert.match(workflow, /node scripts\/verify-release-readiness\.mjs "v\$\{package_version\}" --strict/);
  assert.match(workflow, /git fetch origin main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git rev-list -n 1 "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
});

test("release readiness checker passes for the prepared release candidate", () => {
  const checker = path.join(root, "scripts/verify-release-readiness.mjs");
  const draft = spawnSync(process.execPath, [checker, releaseTag], { encoding: "utf8" });
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stdout, new RegExp(`Release readiness check for ${releaseTagPattern} in draft mode`));
  assert.match(draft.stdout, new RegExp(`OK Release tag matches package\\.json version ${packageJson.version.replaceAll(".", "\\.")}`));
  assert.match(draft.stdout, new RegExp(`OK docs/RELEASE_NOTES_${releaseTagPattern}\\.md has no "TBD before release" placeholders`));
  assert.match(draft.stdout, new RegExp(`OK docs/RELEASE_NOTES_${releaseTagPattern}\\.md is not marked as draft`));
  assert.match(draft.stdout, new RegExp(`OK docs/RELEASE_NOTES_${releaseTagPattern}\\.md has no unchecked release evidence boxes`));
  assert.match(draft.stdout, /Release readiness checks passed/);

  const strict = spawnSync(process.execPath, [checker, releaseTag, "--strict"], { encoding: "utf8" });
  assert.equal(strict.status, 0, strict.stderr);
  assert.match(strict.stdout, new RegExp(`Release readiness check for ${releaseTagPattern} in strict mode`));
  assert.match(strict.stdout, /Release readiness checks passed/);
});

test("package exposes release readiness commands", () => {
  assert.match(packageManifest, new RegExp(`"release:check": "node scripts/verify-release-readiness\\.mjs ${releaseTagPattern}"`));
  assert.match(packageManifest, new RegExp(`"release:check:strict": "node scripts/verify-release-readiness\\.mjs ${releaseTagPattern} --strict"`));
});

test("github workflows use current action runtimes", () => {
  for (const content of [workflow, ciWorkflow]) {
    assert.match(content, /actions\/checkout@v5/);
    assert.match(content, /actions\/setup-node@v5/);
    assert.match(content, /oven-sh\/setup-bun@v2/);
    assert.doesNotMatch(content, /actions\/checkout@v4/);
    assert.doesNotMatch(content, /actions\/setup-node@v4/);
    assert.doesNotMatch(content, /oven-sh\/setup-bun@v1/);
  }
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
  assert.match(workflow, /node scripts\/smoke-start\.mjs --binary "\.\/dist\/bin\/\$\{\{ matrix\.binary \}\}"/);
  assert.match(workflow, /Smoke test occupied port startup failure/);
  assert.match(workflow, /node scripts\/smoke-port-conflict\.mjs --binary "\.\/dist\/bin\/\$\{\{ matrix\.binary \}\}"/);
  assert.match(workflow, /rm -rf dist/);
  assert.match(workflow, /Unexpected file in release package/);
  assert.match(workflow, /package\/LICENSE/);
  assert.match(workflow, /package\/dist\/bin\/"\$\{BINARY\}"/);
  assert.match(workflow, /package\/dist\/ui\/\*/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /if: github\.event_name == 'push'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /Checkout release notes/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /notes_file="docs\/RELEASE_NOTES_\$\{GITHUB_REF_NAME\}\.md"/);
  assert.match(workflow, /notes_args=\(--generate-notes\)/);
  assert.match(workflow, /notes_args=\(--notes-file "\$notes_file"\)/);
  assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --notes-file "\$notes_file"/);
  assert.match(workflow, /"\$\{notes_args\[@\]\}"/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /npm pack --pack-destination release --silent/);
  assert.match(workflow, /release\/orbit-\$\{version\}-\$\{ASSET\}\.tgz/);
  assert.match(workflow, /Publish npm package/);
  assert.match(workflow, /needs: release/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /path: release-assets/);
  assert.match(workflow, /npm run package:npm/);
  assert.match(workflow, /npm publish --dry-run --access public --ignore-scripts/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /npm publish --access public --ignore-scripts/);
  assert.doesNotMatch(workflow, /\.zip"/);
  assert.doesNotMatch(workflow, /\.tar\.gz"/);
});

test("ci smoke-tests the built app startup", () => {
  assert.match(ciWorkflow, /npm run build/);
  assert.match(ciWorkflow, /Smoke test built app startup/);
  assert.match(ciWorkflow, /npm run smoke:start/);
  assert.match(ciWorkflow, /Smoke test occupied port startup failure/);
  assert.match(ciWorkflow, /npm run smoke:port-conflict/);
});

test("release tag verifier accepts the package version, supports prerelease syntax, and rejects mismatches", () => {
  const verifier = path.join(root, "scripts/verify-release-tag.mjs");
  const valid = spawnSync(process.execPath, [verifier, `v${packageJson.version}`], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);

  const prereleaseMismatch = spawnSync(process.execPath, [verifier, `v${packageJson.version}-rc.1`], { encoding: "utf8" });
  assert.notEqual(prereleaseMismatch.status, 0);
  assert.match(prereleaseMismatch.stderr, /does not match package\.json version/);
  assert.doesNotMatch(prereleaseMismatch.stderr, /Invalid release tag/);

  const invalid = spawnSync(process.execPath, [verifier, "v999.0.0"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /does not match package\.json version/);

  const invalidFormat = spawnSync(process.execPath, [verifier, "v1.0"], { encoding: "utf8" });
  assert.notEqual(invalidFormat.status, 0);
  assert.match(invalidFormat.stderr, /Invalid release tag/);
});

test("standalone builds remove generated source maps before packaging", () => {
  assert.match(standaloneBuilder, /fs\.rmSync\(path\.join\(root, "dist", "bin"\)/);
  assert.match(standaloneBuilder, /filename\.endsWith\("\.map"\)/);
  assert.match(standaloneBuilder, /fs\.rmSync\(path\.join\(outDir, filename\)\)/);
  assert.match(standaloneBuilder, /One or more platform builds failed/);
});

test("npm package assembler collects every supported platform artifact", () => {
  for (const asset of ["windows-x64", "linux-x64", "macos-x64", "macos-arm64"]) {
    assert.match(npmAssembler, new RegExp(asset));
  }

  assert.match(npmAssembler, /const binDir = path\.join\(distDir, "bin"\)/);
  assert.match(npmAssembler, /path\.join\(binDir, asset\)/);
  assert.match(npmAssembler, /dist", "ui"/);
  assert.match(npmAssembler, /tar/);
  assert.match(npmAssembler, /endsWith\(`-\$\{asset\}\.tgz`\)/);
});
