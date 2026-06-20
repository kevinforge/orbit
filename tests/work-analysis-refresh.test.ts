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
