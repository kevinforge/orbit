import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { AgentId, AgentRuntimeKind, Conversation, InteractionMode, SupervisorConfig } from "../shared/types.ts";
import { isInteractionMode } from "../shared/types.ts";

type ConversationData = {
  conversations: Conversation[];
};

export class ConversationStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".orbit");
  }

  list(workspaceId: string): Conversation[] {
    const data = this.loadData(workspaceId);
    const sorted = [...data.conversations];
    sorted.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
    return sorted;
  }

  get(workspaceId: string, conversationId: string): Conversation | null {
    const data = this.loadData(workspaceId);
    return data.conversations.find((c) => c.id === conversationId) ?? null;
  }

  create(workspaceId: string, name: string): Conversation {
    const data = this.loadData(workspaceId);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: `conv_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
      workspaceId,
      name,
      createdAt: now,
      lastOpenedAt: now,
      interactionMode: "direct",
    };
    data.conversations.push(conversation);
    this.saveData(workspaceId, data);
    return conversation;
  }

  update(workspaceId: string, conversationId: string, patch: {
    name?: string;
    interactionMode?: InteractionMode;
    supervisorConfig?: SupervisorConfig | null;
    lastDirectAgentId?: AgentId;
  }): Conversation {
    const data = this.loadData(workspaceId);
    const index = data.conversations.findIndex((c) => c.id === conversationId);
    if (index === -1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    data.conversations[index] = {
      ...data.conversations[index]!,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.interactionMode !== undefined ? { interactionMode: patch.interactionMode } : {}),
      ...(patch.supervisorConfig !== undefined
        ? patch.supervisorConfig === null
          ? { supervisorConfig: undefined, supervisionRuntime: undefined }
          : { supervisorConfig: patch.supervisorConfig }
        : {}),
      ...(patch.lastDirectAgentId !== undefined ? { lastDirectAgentId: patch.lastDirectAgentId } : {}),
    };
    this.saveData(workspaceId, data);
    return data.conversations[index]!;
  }

  delete(workspaceId: string, conversationId: string): void {
    const data = this.loadData(workspaceId);
    const index = data.conversations.findIndex((c) => c.id === conversationId);
    if (index === -1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    data.conversations.splice(index, 1);
    this.saveData(workspaceId, data);

    // Clean up data directories for this conversation
    this.cleanupConversationData(workspaceId, conversationId);
  }

  touchLastOpened(workspaceId: string, conversationId: string): void {
    const data = this.loadData(workspaceId);
    const conv = data.conversations.find((c) => c.id === conversationId);
    if (!conv) return;
    conv.lastOpenedAt = new Date().toISOString();
    this.saveData(workspaceId, data);
  }

  private filePath(workspaceId: string): string {
    return path.join(this.baseDir, "conversations", workspaceId, "conversations.json");
  }

  private cleanupConversationData(workspaceId: string, conversationId: string): void {
    // Remove channels data (messages)
    const channelsDir = path.join(this.baseDir, "conversations", workspaceId, conversationId);
    this.rmDir(channelsDir);

    // Remove transcripts
    const transcriptsDir = path.join(this.baseDir, "transcripts", workspaceId, conversationId);
    this.rmDir(transcriptsDir);

    // Remove sessions for all runtimes under this workspace/conversation
    const sessionsBase = path.join(this.baseDir, "sessions", workspaceId);
    try {
      const runtimeDirs = fs.readdirSync(sessionsBase);
      for (const runtime of runtimeDirs) {
        const convSessionsDir = path.join(sessionsBase, runtime, conversationId);
        this.rmDir(convSessionsDir);
      }
    } catch {
      // sessions dir may not exist
    }
  }

  private rmDir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // best effort — directory may not exist
    }
  }

  private loadData(workspaceId: string): ConversationData {
    try {
      const content = fs.readFileSync(this.filePath(workspaceId), "utf8");
      const parsed = JSON.parse(content) as ConversationData;
      return {
        conversations: Array.isArray(parsed.conversations)
          ? parsed.conversations.map(withNormalizedFields)
          : [],
      };
    } catch {
      return { conversations: [] };
    }
  }

  private saveData(workspaceId: string, data: ConversationData): void {
    const filePath = this.filePath(workspaceId);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = filePath + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + os.EOL);
    fs.renameSync(tmpFile, filePath);
  }
}

/**
 * 读取时规范化会话记录：
 * - 非法/缺失的 interactionMode 一律回到默认 direct（无旧格式兼容）。
 * - issue #153 之前只保存 supervisionRuntime，读取时映射为
 *   `supervisorConfig = { runtime: supervisionRuntime }`。不批量迁移数据，
 *   旧字段原样保留，新写入只使用 supervisorConfig。
 */
function withNormalizedFields(conversation: Conversation): Conversation {
  const legacyRuntime = conversation.supervisionRuntime;
  return {
    ...conversation,
    interactionMode: isInteractionMode(conversation.interactionMode)
      ? conversation.interactionMode
      : "direct",
    ...(conversation.supervisorConfig || !legacyRuntime
      ? {}
      : { supervisorConfig: { runtime: legacyRuntime } }),
  };
}
