import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, MessageHistoryState, MessagePage, MessageRouteState, NewChatMessage } from "../shared/types.ts";

type PersistedData = { messages: ChatMessage[]; nextId: number };

type MessageShard = {
  name: string;
  firstCreatedAt: string;
  lastCreatedAt: string;
  count: number;
  bytes: number;
};

type MessageManifest = {
  version: 1;
  nextId: number;
  shards: MessageShard[];
};

export type MessageStoreOptions = {
  recentShardCount?: number;
  now?: () => Date;
};

const MANIFEST_FILE = "manifest.json";
const DEFAULT_RECENT_SHARDS = Number(process.env.ORBIT_MESSAGE_RECENT_SHARDS ?? 3);

export class MessageStore {
  private messages: ChatMessage[] = [];
  private nextId = 1;
  private manifest: MessageManifest = { version: 1, nextId: 1, shards: [] };
  private readonly filePath?: string;
  private readonly recentShardCount: number;
  private readonly now: () => Date;

  constructor(filePath?: string, options: MessageStoreOptions = {}) {
    this.filePath = filePath;
    this.recentShardCount = Math.max(1, options.recentShardCount ?? DEFAULT_RECENT_SHARDS);
    this.now = options.now ?? (() => new Date());
    if (filePath) {
      this.load();
    }
  }

  append(message: NewChatMessage): ChatMessage {
    const stored: ChatMessage = {
      ...message,
      id: this.createId(),
      createdAt: this.now().toISOString(),
    };

    this.messages.push(stored);
    this.messages = sortMessages(this.messages);
    this.saveMessage(stored);
    return stored;
  }

  add(message: NewChatMessage): ChatMessage {
    return this.append(message);
  }

  update(id: string, patch: Partial<Omit<ChatMessage, "id" | "createdAt">>): ChatMessage {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Message not found: ${id}`);
    }

    const updated = { ...existing, ...patch };
    const index = this.messages.findIndex((message) => message.id === id);
    if (index !== -1) {
      this.messages[index] = updated;
      this.messages = sortMessages(this.messages);
    }
    this.rewriteMessageShard(updated);
    return updated;
  }

  list(): ChatMessage[] {
    return [...this.messages];
  }

  get(id: string): ChatMessage | null {
    const loaded = this.messages.find((message) => message.id === id);
    if (loaded) return loaded;
    if (!this.filePath) return null;

    for (const shard of this.manifest.shards) {
      const message = this.readShard(shard.name).find((candidate) => candidate.id === id);
      if (message) return message;
    }
    return null;
  }

  markRouteState(id: string, routeState: MessageRouteState): ChatMessage | null {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }

    const updated = { ...existing, routeState };
    const index = this.messages.findIndex((message) => message.id === id);
    if (index !== -1) {
      this.messages[index] = updated;
      this.messages = sortMessages(this.messages);
    }
    this.rewriteMessageShard(updated);
    return updated;
  }

  historyState(): MessageHistoryState {
    if (!this.filePath || this.messages.length === 0) {
      return { hasOlderMessages: false, olderCursor: null };
    }

    const firstLoaded = this.messages[0];
    const firstLoadedShard = shardNameFor(firstLoaded.createdAt);
    const firstLoadedShardIndex = this.manifest.shards.findIndex((shard) => shard.name === firstLoadedShard);
    const hasOlderMessages = firstLoadedShardIndex > 0;
    return {
      hasOlderMessages,
      olderCursor: hasOlderMessages ? firstLoaded.id : null,
    };
  }

  listBefore(beforeId: string | null | undefined, limit = 50): MessagePage {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const all = this.readAllMessages();
    const beforeIndex = beforeId ? all.findIndex((message) => message.id === beforeId) : all.length;
    const end = beforeIndex === -1 ? all.length : beforeIndex;
    const start = Math.max(0, end - boundedLimit);
    const messages = all.slice(start, end);
    return {
      messages,
      hasOlderMessages: start > 0,
      olderCursor: start > 0 ? messages[0]?.id ?? null : null,
    };
  }

  private createId(): string {
    const id = `msg_${String(this.nextId).padStart(6, "0")}`;
    this.nextId += 1;
    this.manifest.nextId = this.nextId;
    return id;
  }

  private load(): void {
    this.ensureMigrated();
    this.manifest = this.loadManifest();
    this.nextId = this.manifest.nextId;
    const recentShards = this.manifest.shards.slice(-this.recentShardCount);
    this.messages = sortMessages(recentShards.flatMap((shard) => this.readShard(shard.name)));
  }

  private ensureMigrated(): void {
    if (!this.filePath) return;
    if (fs.existsSync(this.manifestPath())) return;

    const legacy = this.loadLegacy();
    if (legacy) {
      const messages = sortMessages(legacy.messages ?? []);
      this.nextId = legacy.nextId ?? nextIdFromMessages(messages);
      this.manifest = { version: 1, nextId: this.nextId, shards: [] };
      this.writeAllMessages(messages);
      return;
    }

    if (fs.existsSync(this.shardDir())) {
      this.manifest = this.rebuildManifest();
      this.saveManifest();
      return;
    }

    this.manifest = { version: 1, nextId: 1, shards: [] };
  }

  private loadLegacy(): PersistedData | null {
    if (!this.filePath || !fs.existsSync(this.filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedData;
    } catch {
      return null;
    }
  }

  private loadManifest(): MessageManifest {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath(), "utf8")) as MessageManifest;
      return {
        version: 1,
        nextId: parsed.nextId ?? nextIdFromMessages([]),
        shards: sortShards(parsed.shards ?? []),
      };
    } catch {
      return this.manifest;
    }
  }

  private saveMessage(message: ChatMessage): void {
    if (!this.filePath) return;
    const shardName = shardNameFor(message.createdAt);
    const shardPath = this.shardPath(shardName);
    fs.mkdirSync(path.dirname(shardPath), { recursive: true });
    fs.appendFileSync(shardPath, JSON.stringify(message) + os.EOL);
    this.upsertShardMetadata(shardName, this.readShard(shardName));
    this.saveManifest();
  }

  private rewriteMessageShard(message: ChatMessage): void {
    if (!this.filePath) return;
    const shardName = this.findShardForMessage(message.id) ?? shardNameFor(message.createdAt);
    const messages = this.readShard(shardName).map((candidate) => (candidate.id === message.id ? message : candidate));
    this.writeShard(shardName, sortMessages(messages));
    this.saveManifest();
  }

  private writeAllMessages(messages: ChatMessage[]): void {
    const grouped = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const shardName = shardNameFor(message.createdAt);
      grouped.set(shardName, [...(grouped.get(shardName) ?? []), message]);
    }

    for (const [shardName, shardMessages] of grouped) {
      this.writeShard(shardName, sortMessages(shardMessages));
    }
    this.saveManifest();
  }

  private writeShard(shardName: string, messages: ChatMessage[]): void {
    if (!this.filePath) return;
    const shardPath = this.shardPath(shardName);
    fs.mkdirSync(path.dirname(shardPath), { recursive: true });
    const tmp = shardPath + ".tmp";
    fs.writeFileSync(tmp, messages.map((message) => JSON.stringify(message)).join(os.EOL) + (messages.length ? os.EOL : ""));
    fs.renameSync(tmp, shardPath);
    this.upsertShardMetadata(shardName, messages);
  }

  private readAllMessages(): ChatMessage[] {
    if (!this.filePath) return [...this.messages];
    return sortMessages(this.manifest.shards.flatMap((shard) => this.readShard(shard.name)));
  }

  private readShard(shardName: string): ChatMessage[] {
    try {
      return fs
        .readFileSync(this.shardPath(shardName), "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ChatMessage);
    } catch {
      return [];
    }
  }

  private findShardForMessage(id: string): string | null {
    for (const shard of this.manifest.shards) {
      if (this.readShard(shard.name).some((message) => message.id === id)) {
        return shard.name;
      }
    }
    return null;
  }

  private upsertShardMetadata(shardName: string, messages: ChatMessage[]): void {
    const existing = this.manifest.shards.filter((shard) => shard.name !== shardName);
    if (messages.length === 0) {
      this.manifest.shards = sortShards(existing);
      return;
    }

    const sorted = sortMessages(messages);
    const shardPath = this.shardPath(shardName);
    const metadata: MessageShard = {
      name: shardName,
      firstCreatedAt: sorted[0].createdAt,
      lastCreatedAt: sorted[sorted.length - 1].createdAt,
      count: sorted.length,
      bytes: fs.existsSync(shardPath) ? fs.statSync(shardPath).size : 0,
    };
    this.manifest.shards = sortShards([...existing, metadata]);
    this.manifest.nextId = Math.max(this.manifest.nextId, this.nextId);
  }

  private rebuildManifest(): MessageManifest {
    const shards: MessageShard[] = [];
    for (const entry of fs.readdirSync(this.shardDir())) {
      if (!entry.endsWith(".ndjson")) continue;
      const messages = sortMessages(this.readShard(entry));
      if (messages.length === 0) continue;
      shards.push({
        name: entry,
        firstCreatedAt: messages[0].createdAt,
        lastCreatedAt: messages[messages.length - 1].createdAt,
        count: messages.length,
        bytes: fs.statSync(this.shardPath(entry)).size,
      });
    }
    return { version: 1, nextId: nextIdFromMessages(this.readAllFromShards(shards)), shards: sortShards(shards) };
  }

  private readAllFromShards(shards: MessageShard[]): ChatMessage[] {
    return sortMessages(shards.flatMap((shard) => this.readShard(shard.name)));
  }

  private saveManifest(): void {
    if (!this.filePath) return;
    const manifestPath = this.manifestPath();
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmp = manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.manifest, null, 2) + os.EOL);
    fs.renameSync(tmp, manifestPath);
  }

  private shardDir(): string {
    if (!this.filePath) throw new Error("Message path is not configured.");
    return path.join(path.dirname(this.filePath), "messages");
  }

  private shardPath(shardName: string): string {
    return path.join(this.shardDir(), shardName);
  }

  private manifestPath(): string {
    return path.join(this.shardDir(), MANIFEST_FILE);
  }
}

function shardNameFor(createdAt: string): string {
  const date = createdAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}.ndjson` : "unknown-date.ndjson";
}

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => {
    const byDate = a.createdAt.localeCompare(b.createdAt);
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  });
}

function sortShards(shards: MessageShard[]): MessageShard[] {
  return [...shards].sort((a, b) => a.name.localeCompare(b.name));
}

function nextIdFromMessages(messages: ChatMessage[]): number {
  let max = 0;
  for (const message of messages) {
    const match = /^msg_(\d+)$/.exec(message.id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}
