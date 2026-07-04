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

test("repository exposes open source contribution and release guidance", () => {
  const contributing = readRepoFile("CONTRIBUTING.md");
  const releaseChecklist = readRepoFile("docs/RELEASE_CHECKLIST.md");
  const releaseNotes = readRepoFile("docs/RELEASE_NOTES_v1.0.0-rc.1.md");
  const stabilityVerification = readRepoFile("docs/STABILITY_VERIFICATION.md");
  const prTemplate = readRepoFile(".github/pull_request_template.md");
  const readme = readRepoFile("README.md");
  const readiness = readRepoFile("docs/OPEN_SOURCE_READINESS.md");

  assert.match(contributing, /Node\.js 20 or newer/);
  assert.match(contributing, /npm audit --audit-level=moderate/);
  assert.match(contributing, /npm run smoke:start/);
  assert.match(contributing, /node --test --import tsx/);
  assert.match(contributing, /~\/\.orbit/);

  assert.match(releaseChecklist, /Cross-Platform Startup/);
  assert.match(releaseChecklist, /Stability And Recovery/);
  assert.match(releaseChecklist, /Windows x64, Linux x64, macOS x64, and macOS ARM64/);
  assert.match(releaseChecklist, /SHA256SUMS\.txt/);
  assert.match(releaseChecklist, /attachments/);
  assert.match(releaseChecklist, /background conversations/);
  assert.match(releaseChecklist, /docs\/RELEASE_NOTES_v1\.0\.0-rc\.1\.md/);
  assert.match(releaseChecklist, /docs\/STABILITY_VERIFICATION\.md/);

  assert.match(releaseNotes, /Status: draft/);
  assert.match(releaseNotes, /GitHub Release Artifacts/);
  assert.match(releaseNotes, /Public npm/);
  assert.match(releaseNotes, /Supported Platforms/);
  assert.match(releaseNotes, /Runtime Prerequisites/);
  assert.match(releaseNotes, /Known Limitations/);
  assert.match(releaseNotes, /Verification Evidence/);
  assert.match(releaseNotes, /SECURITY\.md/);
  assert.match(releaseNotes, /CODE_OF_CONDUCT\.md/);
  assert.match(releaseNotes, /CONTRIBUTING\.md/);
  assert.match(releaseNotes, /docs\/STABILITY_VERIFICATION\.md/);
  assert.match(releaseNotes, /TBD before release/);

  assert.match(stabilityVerification, /Restart Recovery/);
  assert.match(stabilityVerification, /Queue Cancellation/);
  assert.match(stabilityVerification, /Local Data Persistence/);
  assert.match(stabilityVerification, /Background Conversations And Insights/);
  assert.match(stabilityVerification, /markAbandonedActiveRuns/);
  assert.match(stabilityVerification, /GET \/api\/state/);
  assert.match(stabilityVerification, /~\/\.orbit/);
  assert.match(stabilityVerification, /Release Evidence Template/);

  assert.match(prTemplate, /## Verification/);
  assert.match(prTemplate, /npm audit --audit-level=moderate/);
  assert.match(prTemplate, /npm run smoke:start/);
  assert.match(prTemplate, /## Screenshots/);
  assert.match(prTemplate, /## Known Risks And Follow-Up/);

  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /docs\/RELEASE_CHECKLIST\.md/);
  assert.match(readme, /docs\/RELEASE_NOTES_v1\.0\.0-rc\.1\.md/);
  assert.match(readiness, /Contributor baseline/);
  assert.match(readiness, /Release-notes baseline/);
  assert.match(readiness, /Stability-verification baseline/);
  assert.match(readiness, /RELEASE_NOTES_v1\.0\.0-rc\.1\.md/);
  assert.match(readiness, /STABILITY_VERIFICATION\.md/);
  assert.doesNotMatch(readiness, /Add a manual release checklist/);
});

test("repository documents local data backup and reset guidance", () => {
  const dataDirectory = readRepoFile("docs/DATA_DIRECTORY.md");
  const readme = readRepoFile("README.md");
  const quickstart = readRepoFile("docs/QUICKSTART.md");
  const readiness = readRepoFile("docs/OPEN_SOURCE_READINESS.md");
  const contributing = readRepoFile("CONTRIBUTING.md");

  assert.match(dataDirectory, /~\/\.orbit/);
  assert.match(dataDirectory, /workspaces\/<workspace-id>\/workspace\.json/);
  assert.match(dataDirectory, /conversations\/<workspace-id>\/<conversation-id>\/messages/);
  assert.match(dataDirectory, /sessions\/<workspace-id>\/<runtime>/);
  assert.match(dataDirectory, /transcripts\/<workspace-id>/);
  assert.match(dataDirectory, /Back Up Data/);
  assert.match(dataDirectory, /Restore Data/);
  assert.match(dataDirectory, /Delete Or Reset Local Data/);
  assert.match(dataDirectory, /does not delete your\s+source repositories/);
  assert.match(dataDirectory, /does not delete\s+the project directory itself/);

  assert.match(readme, /docs\/DATA_DIRECTORY\.md/);
  assert.match(quickstart, /DATA_DIRECTORY\.md/);
  assert.match(readiness, /Local-data baseline/);
  assert.doesNotMatch(readiness, /Document local data layout and how users can delete or back up/);
  assert.match(contributing, /docs\/DATA_DIRECTORY\.md/);
});

test("repository documents public terminology and routing marker behavior", () => {
  const terminology = readRepoFile("docs/TERMINOLOGY_AND_ROUTING.md");
  const readme = readRepoFile("README.md");
  const quickstart = readRepoFile("docs/QUICKSTART.md");
  const readiness = readRepoFile("docs/OPEN_SOURCE_READINESS.md");
  const contributing = readRepoFile("CONTRIBUTING.md");

  assert.match(terminology, /Digital employee/);
  assert.match(terminology, /Prefer \*\*digital employee\*\*/);
  assert.match(terminology, /@developer:/);
  assert.match(terminology, /@all:/);
  assert.match(terminology, /Plain `@id` without a colon is a reference only/);
  assert.match(terminology, /Unknown `@id:` markers are ignored/);
  assert.match(terminology, /empty assignment/);
  assert.match(terminology, /routing depth 10/);
  assert.match(terminology, /Handoffs/);

  assert.match(readme, /docs\/TERMINOLOGY_AND_ROUTING\.md/);
  assert.match(quickstart, /TERMINOLOGY_AND_ROUTING\.md/);
  assert.match(readiness, /Terminology baseline/);
  assert.doesNotMatch(readiness, /Document the product terms used in the UI/);
  assert.match(contributing, /docs\/TERMINOLOGY_AND_ROUTING\.md/);
});
