#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const tag = args.find((arg) => !arg.startsWith("--")) ?? process.env.GITHUB_REF_NAME ?? "";
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expectedTag = `v${packageJson.version}`;
const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const results = [];

function record(ok, okMessage, blockerMessage = okMessage) {
  results.push({ ok, message: ok ? okMessage : blockerMessage });
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

if (!tag) {
  record(false, "Release tag is required. Pass v<major>.<minor>.<patch> or set GITHUB_REF_NAME.");
} else if (!releaseTagPattern.test(tag)) {
  record(false, `Release tag "${tag}" must be v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<prerelease>.`);
} else {
  record(true, `Release tag "${tag}" has a valid semantic-version format.`);
}

if (tag && tag === expectedTag) {
  record(true, `Release tag matches package.json version ${packageJson.version}.`);
} else if (tag) {
  record(false, `Release tag ${tag} does not match package.json version ${packageJson.version}. Expected ${expectedTag}.`);
}

const requiredFiles = [
  "LICENSE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SUPPORT.md",
  "docs/DEPENDENCY_LICENSES.md",
  "docs/RELEASE_CHECKLIST.md",
  "docs/RELEASE_DECISIONS.md",
  "docs/STABILITY_VERIFICATION.md",
  "docs/DATA_DIRECTORY.md",
  "docs/TERMINOLOGY_AND_ROUTING.md",
  "docs/OPEN_SOURCE_READINESS.md",
];

for (const relativePath of requiredFiles) {
  record(fileExists(relativePath), `${relativePath} is present.`);
}

record(packageJson.private === false, "package.json is publishable with private=false.");
record(packageJson.license === "MIT", "package.json declares the MIT license.");
record(Boolean(packageJson.repository?.url), "package.json includes a repository URL.");
record(Boolean(packageJson.bugs?.url), "package.json includes a bug-report URL.");
record(Boolean(packageJson.homepage), "package.json includes a homepage URL.");
record(Array.isArray(packageJson.files) && packageJson.files.length > 0, "package.json restricts published files.");

if (tag) {
  const releaseNotesPath = `docs/RELEASE_NOTES_${tag}.md`;
  if (fileExists(releaseNotesPath)) {
    const releaseNotes = readRepoFile(releaseNotesPath);
    record(true, `${releaseNotesPath} is present.`);
    record(
      !/TBD before release/i.test(releaseNotes),
      `${releaseNotesPath} has no "TBD before release" placeholders.`,
      `${releaseNotesPath} still contains "TBD before release" placeholders.`,
    );
    record(
      !/^Status:\s*draft\b/im.test(releaseNotes),
      `${releaseNotesPath} is not marked as draft.`,
      `${releaseNotesPath} is still marked as draft.`,
    );
    record(
      !/- \[ \]/.test(releaseNotes),
      `${releaseNotesPath} has no unchecked release evidence boxes.`,
      `${releaseNotesPath} still has unchecked release evidence boxes.`,
    );

    for (const requiredReference of ["SECURITY.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md"]) {
      record(releaseNotes.includes(requiredReference), `${releaseNotesPath} links ${requiredReference}.`);
    }
  } else {
    record(false, `${releaseNotesPath} is required so the GitHub Release body is auditable.`);
  }
}

const blockers = results.filter((result) => !result.ok);
const mode = strict ? "strict" : "draft";

console.log(`Release readiness check for ${tag || "(missing tag)"} in ${mode} mode`);
for (const result of results) {
  console.log(`${result.ok ? "OK" : "BLOCKER"} ${result.message}`);
}

if (blockers.length > 0) {
  console.log(`${blockers.length} release blocker${blockers.length === 1 ? "" : "s"} found.`);
  if (strict) {
    process.exit(1);
  }
  console.log("Draft mode allows blockers so release preparation can continue before final evidence is attached.");
} else {
  console.log("Release readiness checks passed.");
}
