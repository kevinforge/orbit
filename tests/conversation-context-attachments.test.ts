import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationContext } from "../src/server/conversation-context.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";
import { WorkspaceStore } from "../src/core/workspace-store.ts";
import type { AgentProfile, MessageAttachment } from "../src/shared/types.ts";

/**
 * 回归：ConversationContext.buildRuntimePrompt 曾接收 imagePaths 却没有传给
 * buildAgentContext，导致 <current-attachments> 从未进入生产提示词。
 * 这里直接驱动 buildRuntimePrompt 验证源消息附件进入了运行时提示词。
 */
function makeContext(): { baseDir: string; ctx: ConversationContext } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ctx-attachments-"));
  const workspaceStore = new WorkspaceStore(baseDir);
  const profiles: AgentProfile[] = [{
    id: "dev",
    name: "开发",
    runtime: "claude-code",
    cwd: baseDir,
    systemPrompt: "",
  }];
  const ctx = new ConversationContext({
    workspaceId: "ws1",
    conversationId: "conv1",
    profiles,
    eventBus: new EventBus(),
    sessionStore: new SessionStore(workspaceStore.sessionsDir("ws1")),
    workspaceStore,
    interactionMode: "direct",
  });
  return { baseDir, ctx };
}

test("ConversationContext passes source attachments into the runtime prompt", () => {
  const { baseDir, ctx } = makeContext();
  try {
    const attachments: MessageAttachment[] = [
      {
        id: "a1", kind: "image", mimeType: "image/png", filename: "shot.png",
        path: "/tmp/shot.png", url: "/api/attachments/ws1/conv1/a1", size: 2048,
        createdAt: new Date().toISOString(),
      },
      {
        id: "a2", kind: "file", mimeType: "application/pdf", filename: "spec.pdf",
        path: "/tmp/spec.pdf", url: "/api/attachments/ws1/conv1/a2", size: 125952,
        createdAt: new Date().toISOString(),
      },
    ];
    const prompt = (ctx as unknown as {
      buildRuntimePrompt: (
        agentId: string,
        prompt: string,
        sourceMessageId?: string,
        sourceAttachments?: MessageAttachment[],
        interactionMode?: "direct",
      ) => string;
    }).buildRuntimePrompt("dev", "do work", undefined, attachments, "direct");

    assert.ok(prompt.includes("<current-attachments>"), "attachments must reach the production prompt");
    assert.ok(prompt.includes("shot.png"));
    assert.ok(prompt.includes("spec.pdf"));
  } finally {
    ctx.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
