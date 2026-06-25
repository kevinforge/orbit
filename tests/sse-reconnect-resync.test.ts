import test from "node:test";
import assert from "node:assert/strict";

import { shouldResyncOnReconnect } from "../src/ui/App.tsx";

test("shouldResyncOnReconnect skips the first EventSource open", () => {
  // The initial onopen races the mount-time state fetch, so the first open
  // must NOT trigger a redundant extra resync.
  assert.equal(shouldResyncOnReconnect(false), false);
});

test("shouldResyncOnReconnect resyncs on every later (re)connection", () => {
  // Every later open is a reconnect after a dropped stream: runtime events
  // emitted while disconnected were lost, so the UI must re-fetch state.
  assert.equal(shouldResyncOnReconnect(true), true);
});
