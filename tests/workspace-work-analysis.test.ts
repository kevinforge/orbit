import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentConfigStore } from "../src/core/agent-config-store.ts";
import { ConversationStore } from "../src/core/conversation-store.ts";
import { MessageStore } from "../src/core/message-store.ts";
import { WorkspaceStore } from "../src/core/workspace-store.ts";
import { buildWorkspaceWorkAnalysis } from "../src/server/workspace-work-analysis.ts";

const NOW = new Date("2026-06-20T12:00:00.000Z");
const WORKSPACE_ID = "ws-analysis";

function storeWithClock(filePath: string, clock: { now: string }): MessageStore {
  return new MessageStore(filePath, { now: () => new Date(clock.now) });
}

/** Seed a single completed developer task rooted at a user message, at the given day. */
function seedCompletedTask(baseDir: string, workspaceId: string, conversationId: string, userText: string, day: string): void {
  const filePath = path.join(baseDir, "conversations", workspaceId, conversationId, "messages.json");
  const clock = { now: `${day}T10:00:00.000Z` };
  const store = storeWithClock(filePath, clock);
  const user = store.append({ kind: "user", content: userText });
  clock.now = `${day}T10:00:05.000Z`;
  store.append({
    kind: "agent",
    agentId: "developer",
    runId: `run-${conversationId}`,
    runStatus: "completed",
    status: "done",
    parentMessageId: user.id,
    startedAt: `${day}T10:00:05.000Z`,
    completedAt: `${day}T10:02:00.000Z`,
    content: `${userText} done`,
  });
}

test("buildWorkspaceWorkAnalysis reads only window shards and skips inactive conversations", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-wa-test-"));
  const originalReadFileSync = fs.readFileSync;
  const readNdjson: string[] = [];
  try {
    const workspaceStore = new WorkspaceStore(baseDir);
    const conversationStore = new ConversationStore(baseDir);
    const agentConfigStore = new AgentConfigStore(baseDir);

    const recent = conversationStore.create(WORKSPACE_ID, "近期会话");
    const old = conversationStore.create(WORKSPACE_ID, "陈旧会话");

    seedCompletedTask(baseDir, WORKSPACE_ID, recent.id, "@developer: 实现登录", "2026-06-19");
    seedCompletedTask(baseDir, WORKSPACE_ID, old.id, "@developer: 历史需求", "2026-01-01");

    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      const targetPath = String(args[0]);
      if (targetPath.endsWith(".ndjson")) {
        readNdjson.push(targetPath);
      }
      return originalReadFileSync(...args);
    }) as typeof fs.readFileSync;

    const analysis = buildWorkspaceWorkAnalysis({
      workspaceId: WORKSPACE_ID,
      days: 7,
      workspaceStore,
      conversationStore,
      agentConfigStore,
      now: NOW,
    });

    // Only the recent task is in window; the old conversation contributes nothing.
    assert.equal(analysis.summary.totalTasks, 1);
    assert.equal(analysis.tasks[0]?.title, "实现登录");

    // The old conversation's January shard must never be opened; only the recent
    // conversation's in-window shard is read.
    assert.ok(
      readNdjson.every((shard) => !shard.includes(old.id) && !shard.includes("2026-01-01.ndjson")),
      `inactive conversation shards were read: ${readNdjson.join(", ")}`,
    );
    assert.ok(
      readNdjson.some((shard) => shard.includes(recent.id) && shard.includes("2026-06-19.ndjson")),
      `expected the recent conversation shard to be read, got ${readNdjson.join(", ")}`,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
