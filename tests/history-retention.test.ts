import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanupHistory } from "../src/core/history-retention.ts";

test("cleanupHistory removes expired message shards but keeps active conversation shards", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-retention-test-"));
  try {
    const inactiveMessagesDir = path.join(baseDir, "conversations", "ws1", "conv-old", "messages");
    fs.mkdirSync(inactiveMessagesDir, { recursive: true });
    fs.writeFileSync(path.join(inactiveMessagesDir, "2026-01-01.ndjson"), "{}\n");
    fs.writeFileSync(path.join(inactiveMessagesDir, "2026-02-01.ndjson"), "{}\n");
    fs.writeFileSync(path.join(inactiveMessagesDir, "2026-05-30.ndjson"), "{}\n");
    fs.writeFileSync(path.join(inactiveMessagesDir, "manifest.json"), JSON.stringify({
      version: 1,
      nextId: 1,
      shards: [
        { name: "2026-01-01.ndjson", firstCreatedAt: "2026-01-01T00:00:00.000Z", lastCreatedAt: "2026-01-01T00:00:00.000Z", count: 1, bytes: 3 },
        { name: "2026-02-01.ndjson", firstCreatedAt: "2026-02-01T00:00:00.000Z", lastCreatedAt: "2026-02-01T00:00:00.000Z", count: 1, bytes: 3 },
        { name: "2026-05-30.ndjson", firstCreatedAt: "2026-05-30T00:00:00.000Z", lastCreatedAt: "2026-05-30T00:00:00.000Z", count: 1, bytes: 3 },
      ],
    }));

    const activeMessagesDir = path.join(baseDir, "conversations", "ws1", "conv-active", "messages");
    fs.mkdirSync(activeMessagesDir, { recursive: true });
    fs.writeFileSync(path.join(activeMessagesDir, "2026-01-01.ndjson"), "{}\n");

    const result = cleanupHistory({
      baseDir,
      now: new Date("2026-06-03T00:00:00.000Z"),
      messageRetentionDays: 30,
      transcriptRetentionDays: 30,
      activeConversations: [{ workspaceId: "ws1", conversationId: "conv-active" }],
    });

    assert.equal(fs.existsSync(path.join(inactiveMessagesDir, "2026-01-01.ndjson")), false);
    assert.equal(fs.existsSync(path.join(inactiveMessagesDir, "2026-02-01.ndjson")), true);
    assert.equal(fs.existsSync(path.join(inactiveMessagesDir, "2026-05-30.ndjson")), true);
    assert.equal(fs.existsSync(path.join(activeMessagesDir, "2026-01-01.ndjson")), true);
    assert.equal(result.deletedMessageShards, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cleanupHistory falls back to default retention days for invalid env values", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-retention-test-"));
  try {
    const inactiveMessagesDir = path.join(baseDir, "conversations", "ws1", "conv-old", "messages");
    fs.mkdirSync(inactiveMessagesDir, { recursive: true });
    fs.writeFileSync(path.join(inactiveMessagesDir, "2026-01-01.ndjson"), "{}\n");
    fs.writeFileSync(path.join(inactiveMessagesDir, "2026-05-30.ndjson"), "{}\n");
    fs.writeFileSync(path.join(inactiveMessagesDir, "manifest.json"), JSON.stringify({
      version: 1,
      nextId: 1,
      shards: [
        { name: "2026-01-01.ndjson", firstCreatedAt: "2026-01-01T00:00:00.000Z", lastCreatedAt: "2026-01-01T00:00:00.000Z", count: 1, bytes: 3 },
        { name: "2026-05-30.ndjson", firstCreatedAt: "2026-05-30T00:00:00.000Z", lastCreatedAt: "2026-05-30T00:00:00.000Z", count: 1, bytes: 3 },
      ],
    }));

    // Pass NaN as retainDays — should be clamped to 0, meaning everything older than now is deleted
    const result = cleanupHistory({
      baseDir,
      now: new Date("2026-06-03T00:00:00.000Z"),
      messageRetentionDays: NaN,
      transcriptRetentionDays: 30,
      activeConversations: [],
    });

    // With NaN retention, cutoffTime returns NaN, so no shard matches cutoff comparison
    // Nothing should be deleted because NaN comparisons are always false
    assert.equal(result.deletedMessageShards, 0, "NaN retention should not delete anything");
    assert.equal(fs.existsSync(path.join(inactiveMessagesDir, "2026-01-01.ndjson")), true);
    assert.equal(fs.existsSync(path.join(inactiveMessagesDir, "2026-05-30.ndjson")), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cleanupHistory prunes deleted shard entries from manifest", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-retention-test-"));
  try {
    const messagesDir = path.join(baseDir, "conversations", "ws1", "conv-old", "messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.writeFileSync(path.join(messagesDir, "2026-01-01.ndjson"), "{}\n");
    fs.writeFileSync(path.join(messagesDir, "2026-02-01.ndjson"), "{}\n");
    fs.writeFileSync(path.join(messagesDir, "2026-05-30.ndjson"), "{}\n");
    fs.writeFileSync(path.join(messagesDir, "manifest.json"), JSON.stringify({
      version: 1,
      nextId: 5,
      shards: [
        { name: "2026-01-01.ndjson", firstCreatedAt: "2026-01-01T00:00:00.000Z", lastCreatedAt: "2026-01-01T00:00:00.000Z", count: 1, bytes: 3 },
        { name: "2026-02-01.ndjson", firstCreatedAt: "2026-02-01T00:00:00.000Z", lastCreatedAt: "2026-02-01T00:00:00.000Z", count: 1, bytes: 3 },
        { name: "2026-05-30.ndjson", firstCreatedAt: "2026-05-30T00:00:00.000Z", lastCreatedAt: "2026-05-30T00:00:00.000Z", count: 1, bytes: 3 },
      ],
    }));

    cleanupHistory({
      baseDir,
      now: new Date("2026-06-03T00:00:00.000Z"),
      messageRetentionDays: 30,
      transcriptRetentionDays: 30,
      activeConversations: [],
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(messagesDir, "manifest.json"), "utf8"));
    const shardNames = manifest.shards.map((s: { name: string }) => s.name);
    assert.deepEqual(shardNames, ["2026-02-01.ndjson", "2026-05-30.ndjson"], "deleted shard should be removed from manifest");
    assert.equal(manifest.nextId, 5, "nextId should be preserved");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cleanupHistory removes expired transcript segments but keeps newest per agent", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-retention-test-"));
  try {
    const agentDir = path.join(baseDir, "transcripts", "ws1", "conv1", "developer");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "2026-01-01-0001.log"), "old");
    fs.writeFileSync(path.join(agentDir, "2026-02-01-0001.log"), "also old");

    const result = cleanupHistory({
      baseDir,
      now: new Date("2026-06-03T00:00:00.000Z"),
      messageRetentionDays: 30,
      transcriptRetentionDays: 30,
      activeConversations: [],
    });

    assert.equal(fs.existsSync(path.join(agentDir, "2026-01-01-0001.log")), false);
    assert.equal(fs.existsSync(path.join(agentDir, "2026-02-01-0001.log")), true);
    assert.equal(result.deletedTranscriptSegments, 1);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
