import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/WorkAnalysisPanel.tsx"),
  "utf8",
);

test("work analysis exposes a refresh control that retriggers data loading", () => {
  assert.match(source, /className="analysisRefreshBtn"/);
  assert.match(source, /setRefreshVersion\(\(version\) => version \+ 1\)/);
  assert.match(source, /\[days, props\.workspaceId, refreshVersion\]/);
});

test("refresh keeps existing analysis visible while the request is in progress", () => {
  assert.match(source, /loading && !analysis \? <AnalysisLoading/);
  assert.match(source, /\{analysis \? \(/);
});

test("timeline uses distinct colors for running, completed, and empty track states", () => {
  const styles = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/ui/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.taskTimelineTrack\s*\{[^}]*background: var\(--bg-surface\)/s);
  assert.match(styles, /\.taskTimelineBar\.running\s*\{[^}]*background: var\(--warning\)/s);
  assert.match(styles, /\.taskTimelineBar\.completed\s*\{[^}]*background: var\(--success\)/s);
});

test("collaboration insights keeps employee names left aligned and uses a distinct running status color", () => {
  const styles = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/ui/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.compactAgents \.agentButton\.statusHidden\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
  assert.match(styles, /\.taskStatusLabel\.running\s*\{[^}]*color: var\(--warning\)/s);
});

test("work analysis is renamed and does not label parallel timelines", () => {
  assert.match(source, /<h1>协作洞察<\/h1>/);
  assert.doesNotMatch(source, />并行执行</);
});
