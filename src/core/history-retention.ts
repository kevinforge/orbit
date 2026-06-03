import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
};

type MessageManifest = {
  version: 1;
  nextId: number;
  shards: Array<{ name: string; firstCreatedAt: string; lastCreatedAt: string; count: number; bytes: number }>;
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
  const result: HistoryRetentionResult = { deletedMessageShards: 0, deletedTranscriptSegments: 0 };

  result.deletedMessageShards += cleanupMessageShards(
    path.join(baseDir, "conversations"),
    cutoffTime(now, options.messageRetentionDays ?? DEFAULT_MESSAGE_RETAIN_DAYS),
    activeKeys,
  );
  result.deletedTranscriptSegments += cleanupTranscriptSegments(
    path.join(baseDir, "transcripts"),
    cutoffTime(now, options.transcriptRetentionDays ?? DEFAULT_TRANSCRIPT_RETAIN_DAYS),
    activeKeys,
  );

  return result;
}

function cleanupMessageShards(conversationsDir: string, cutoff: number, activeKeys: Set<string>): number {
  let deleted = 0;
  for (const { workspaceId, conversationId, dir } of eachConversationDir(conversationsDir)) {
    if (activeKeys.has(conversationKey(workspaceId, conversationId))) continue;
    const messagesDir = path.join(dir, "messages");
    const shards = listFiles(messagesDir, ".ndjson").sort();
    const keep = new Set(shards.slice(-2));
    for (const shard of shards) {
      if (keep.has(shard)) continue;
      const shardTime = messageShardTime(shard);
      if (shardTime === null || shardTime >= cutoff) continue;
      try {
        fs.rmSync(path.join(messagesDir, shard), { force: true });
        deleted += 1;
      } catch {
        // best effort retention
      }
    }
    pruneMessageManifest(messagesDir);
  }
  return deleted;
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
