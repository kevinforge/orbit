import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { Conversation } from "../shared/types.ts";

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
    };
    data.conversations.push(conversation);
    this.saveData(workspaceId, data);
    return conversation;
  }

  update(workspaceId: string, conversationId: string, patch: { name?: string }): Conversation {
    const data = this.loadData(workspaceId);
    const index = data.conversations.findIndex((c) => c.id === conversationId);
    if (index === -1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    data.conversations[index] = {
      ...data.conversations[index]!,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
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

  ensureDefault(workspaceId: string): Conversation {
    const data = this.loadData(workspaceId);
    if (data.conversations.length > 0) {
      return data.conversations.reduce((a, b) =>
        a.lastOpenedAt > b.lastOpenedAt ? a : b,
      );
    }
    const now = new Date().toISOString();
    const defaultConv: Conversation = {
      id: "default",
      workspaceId,
      name: "Default",
      createdAt: now,
      lastOpenedAt: now,
    };
    data.conversations.push(defaultConv);
    this.saveData(workspaceId, data);
    return defaultConv;
  }

  private filePath(workspaceId: string): string {
    return path.join(this.baseDir, "channels", workspaceId, "default", "conversations.json");
  }

  private cleanupConversationData(workspaceId: string, conversationId: string): void {
    // Remove channels data (messages)
    const channelsDir = path.join(this.baseDir, "channels", workspaceId, "default", conversationId);
    this.rmDir(channelsDir);

    // Remove transcripts
    const transcriptsDir = path.join(this.baseDir, "transcripts", workspaceId, "default", conversationId);
    this.rmDir(transcriptsDir);

    // Remove sessions for all runtimes under this workspace/channel/conversation
    const sessionsBase = path.join(this.baseDir, "sessions", workspaceId);
    try {
      const runtimeDirs = fs.readdirSync(sessionsBase);
      for (const runtime of runtimeDirs) {
        const convSessionsDir = path.join(sessionsBase, runtime, "default", conversationId);
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
      return JSON.parse(content) as ConversationData;
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
