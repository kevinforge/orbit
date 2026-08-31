import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessageManifest } from "./message-store.ts";
import {
  ATTACHMENT_FILENAME_INDEX_FILE,
  readAttachmentFilenameIndex,
  writeAttachmentFilenameIndex,
} from "./attachment-filename-index.ts";

export type ActiveConversationRef = {
  workspaceId: string;
  conversationId: string;
};

export type HistoryRetentionOptions = {
  baseDir?: string;
  now?: Date;
  messageRetentionDays?: number;
  transcriptRetentionDays?: number;
  activeConversations?: ActiveConversationRef[];
};

export type HistoryRetentionResult = {
  deletedMessageShards: number;
  deletedTranscriptSegments: number;
  deletedAttachments: number;
};

const DEFAULT_MESSAGE_RETAIN_DAYS = parsePositiveIntEnv("ORBIT_HISTORY_RETAIN_DAYS", 90);
const DEFAULT_TRANSCRIPT_RETAIN_DAYS = parsePositiveIntEnv("ORBIT_TRANSCRIPT_RETAIN_DAYS", 30);

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return fallback;
  return value;
}

export function cleanupHistory(options: HistoryRetentionOptions = {}): HistoryRetentionResult {
  const baseDir = options.baseDir ?? path.join(os.homedir(), ".orbit");
  const now = options.now ?? new Date();
  const activeKeys = new Set((options.activeConversations ?? []).map((ref) => conversationKey(ref.workspaceId, ref.conversationId)));
  const result: HistoryRetentionResult = {
    deletedMessageShards: 0,
    deletedTranscriptSegments: 0,
    deletedAttachments: 0,
  };

  result.deletedMessageShards += cleanupMessageShards(
    path.join(baseDir, "conversations"),
    cutoffTime(now, options.messageRetentionDays ?? DEFAULT_MESSAGE_RETAIN_DAYS),
    activeKeys,
    result,
  );
  result.deletedTranscriptSegments += cleanupTranscriptSegments(
    path.join(baseDir, "transcripts"),
    cutoffTime(now, options.transcriptRetentionDays ?? DEFAULT_TRANSCRIPT_RETAIN_DAYS),
    activeKeys,
  );

  return result;
}

function cleanupMessageShards(
  conversationsDir: string,
  cutoff: number,
  activeKeys: Set<string>,
  result: HistoryRetentionResult,
): number {
  let deleted = 0;
  for (const { workspaceId, conversationId, dir } of eachConversationDir(conversationsDir)) {
    if (activeKeys.has(conversationKey(workspaceId, conversationId))) continue;
    const messagesDir = path.join(dir, "messages");
    const shards = listFiles(messagesDir, ".ndjson").sort();
    const keep = new Set(shards.slice(-2));
    let deletedHere = 0;
    for (const shard of shards) {
      if (keep.has(shard)) continue;
      const shardTime = messageShardTime(shard);
      if (shardTime === null || shardTime >= cutoff) continue;
      try {
        fs.rmSync(path.join(messagesDir, shard), { force: true });
        deleted += 1;
        deletedHere += 1;
      } catch {
        // best effort retention
      }
    }
    pruneMessageManifest(messagesDir);
    // 消息分片被回收后，只有它引用过的附件就成了永久孤儿（此前没有任何
    // 回收路径）。仅在本会话确实删过分片时才做核对，避免启动时全量读取。
    if (deletedHere > 0) {
      result.deletedAttachments += reclaimOrphanAttachments(dir, cutoff);
    }
  }
  return deleted;
}

/**
 * 回收不再被任何保留分片引用的永久附件，并同步收紧文件名索引。
 *
 * 判定以"剩余分片里实际引用的附件 id"为准，而不是按时间：最后两个分片
 * 无论多旧都会保留，仅按 mtime 删除会误删它们引用的附件。mtime 只作为
 * 兜底保护——刚落盘的附件所在分片必然保留，遇到损坏行解析不出来时也不
 * 会被误删。
 */
function reclaimOrphanAttachments(conversationDir: string, cutoff: number): number {
  const attachmentsDir = path.join(conversationDir, "attachments");
  const stored = listAttachmentFiles(attachmentsDir);
  if (stored.length === 0) return 0;

  const referenced = referencedAttachmentIds(path.join(conversationDir, "messages"));
  let reclaimed = 0;
  for (const name of stored) {
    const id = storedNameAttachmentId(name);
    if (!id || referenced.has(id)) continue;
    const filePath = path.join(attachmentsDir, name);
    try {
      if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
      fs.rmSync(filePath, { force: true });
      reclaimed += 1;
    } catch {
      // best effort retention
    }
  }

  const index = readAttachmentFilenameIndex(attachmentsDir);
  const pruned = Object.fromEntries(Object.entries(index).filter(([id]) => referenced.has(id)));
  if (Object.keys(pruned).length !== Object.keys(index).length) {
    writeAttachmentFilenameIndex(attachmentsDir, pruned);
  }
  return reclaimed;
}

function referencedAttachmentIds(messagesDir: string): Set<string> {
  const ids = new Set<string>();
  for (const shard of listFiles(messagesDir, ".ndjson")) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(messagesDir, shard), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const message = JSON.parse(line) as { attachments?: Array<{ id?: unknown }> };
        for (const attachment of message.attachments ?? []) {
          if (attachment && typeof attachment.id === "string" && attachment.id) {
            ids.add(attachment.id);
          }
        }
      } catch {
        // 截断/损坏行按缺失处理，与 readShard 一致
      }
    }
  }
  return ids;
}

function listAttachmentFiles(attachmentsDir: string): string[] {
  try {
    return fs.readdirSync(attachmentsDir).filter((entry) => {
      if (entry === ATTACHMENT_FILENAME_INDEX_FILE) return false;
      try {
        return fs.statSync(path.join(attachmentsDir, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function storedNameAttachmentId(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(0, dot);
}

function cleanupTranscriptSegments(transcriptsDir: string, cutoff: number, activeKeys: Set<string>): number {
  let deleted = 0;
  for (const { workspaceId, conversationId, dir } of eachConversationDir(transcriptsDir)) {
    if (activeKeys.has(conversationKey(workspaceId, conversationId))) continue;
    for (const agent of listDirs(dir)) {
      const agentDir = path.join(dir, agent);
      const segments = listFiles(agentDir, ".log").filter((entry) => /^\d{4}-\d{2}-\d{2}-\d{4}\.log$/.test(entry)).sort();
      const latest = segments[segments.length - 1];
      for (const segment of segments) {
        if (segment === latest) continue;
        const segmentTime = transcriptSegmentTime(segment);
        if (segmentTime === null || segmentTime >= cutoff) continue;
        try {
          fs.rmSync(path.join(agentDir, segment), { force: true });
          deleted += 1;
        } catch {
          // best effort retention
        }
      }
    }
  }
  return deleted;
}

function pruneMessageManifest(messagesDir: string): void {
  const manifestPath = path.join(messagesDir, "manifest.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MessageManifest;
    const existing = new Set(listFiles(messagesDir, ".ndjson"));
    const nextManifest: MessageManifest = {
      ...manifest,
      shards: (manifest.shards ?? []).filter((shard) => existing.has(shard.name)),
    };
    const tmp = manifestPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(nextManifest, null, 2) + os.EOL);
    fs.renameSync(tmp, manifestPath);
  } catch {
    // missing or malformed manifest; cleanup can continue without blocking startup
  }
}

function* eachConversationDir(root: string): Generator<{ workspaceId: string; conversationId: string; dir: string }> {
  for (const workspaceId of listDirs(root)) {
    const workspaceDir = path.join(root, workspaceId);
    for (const conversationId of listDirs(workspaceDir)) {
      yield { workspaceId, conversationId, dir: path.join(workspaceDir, conversationId) };
    }
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((entry) => {
      try {
        return fs.statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return fs.readdirSync(dir).filter((entry) => {
      try {
        return entry.endsWith(suffix) && fs.statSync(path.join(dir, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function cutoffTime(now: Date, retainDays: number): number {
  return now.getTime() - Math.max(0, retainDays) * 24 * 60 * 60 * 1000;
}

function messageShardTime(name: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
  if (!match) return null;
  const time = new Date(`${match[1]}T00:00:00.000Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

function transcriptSegmentTime(name: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})-\d{4}\.log$/.exec(name);
  if (!match) return null;
  const time = new Date(`${match[1]}T00:00:00.000Z`).getTime();
  return Number.isNaN(time) ? null : time;
}

function conversationKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}:${conversationId}`;
}
