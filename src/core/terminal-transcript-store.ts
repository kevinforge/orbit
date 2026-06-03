import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "./ansi-text-extractor.ts";
import type { AgentId, TerminalState } from "../shared/types.ts";

const RETRY_SAVE_DELAY_MS = 50;
const DEFAULT_MAX_SEGMENT_BYTES = Number(process.env.ORBIT_TRANSCRIPT_MAX_BYTES ?? 1024 * 1024);
const DEFAULT_TAIL_BYTES = Number(process.env.ORBIT_TRANSCRIPT_TAIL_BYTES ?? 64 * 1024);

export type TerminalTranscriptStoreOptions = {
  maxSegmentBytes?: number;
  tailBytes?: number;
  now?: () => Date;
};

type SegmentState = {
  name: string;
  bytes: number;
};

export class TerminalTranscriptStore {
  private transcripts: TerminalState = {};
  private handles = new Map<AgentId, number>();
  private persistedLengths = new Map<AgentId, number>();
  private retryTimers = new Map<AgentId, ReturnType<typeof setTimeout>>();
  private warnedAgents = new Set<AgentId>();
  private pendingBuffers = new Map<AgentId, string>();
  private segments = new Map<AgentId, SegmentState>();
  private readonly dirPath?: string;
  private readonly maxSegmentBytes: number;
  private readonly tailBytes: number;
  private readonly now: () => Date;

  constructor(dirPath?: string, options: TerminalTranscriptStoreOptions = {}) {
    this.dirPath = dirPath;
    this.maxSegmentBytes = Math.max(1, options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES);
    this.tailBytes = Math.max(1, options.tailBytes ?? DEFAULT_TAIL_BYTES);
    this.now = options.now ?? (() => new Date());
    if (dirPath) {
      this.load();
    }
  }

  append(agentId: AgentId, chunk: string): string {
    const cleaned = stripAnsi(chunk);
    this.transcripts[agentId] ??= "";
    this.transcripts[agentId] += cleaned;
    this.saveAgentChunk(agentId, cleaned);
    return this.transcripts[agentId];
  }

  get(agentId: AgentId): string {
    return this.transcripts[agentId] ?? "";
  }

  list(): TerminalState {
    return { ...this.transcripts };
  }

  all(): TerminalState {
    return this.list();
  }

  dispose(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    for (const agentId of this.handles.keys()) {
      this.closeHandle(agentId);
    }
  }

  private load(): void {
    if (!this.dirPath) return;
    try {
      const entries = fs.readdirSync(this.dirPath);
      const legacyTails = new Map<AgentId, string>();
      const segmentTails = new Map<AgentId, string>();
      for (const entry of entries) {
        const entryPath = path.join(this.dirPath, entry);
        const stat = safeStat(entryPath);
        if (!stat) continue;

        if (stat.isFile() && entry.endsWith(".log")) {
          const agentId = entry.slice(0, -4);
          legacyTails.set(agentId, tailFiles([entryPath], this.tailBytes));
          continue;
        }

        if (stat.isDirectory()) {
          const tail = this.loadAgentSegments(entry);
          if (tail !== null) {
            segmentTails.set(entry, tail);
          }
        }
      }

      const agentIds = new Set([...legacyTails.keys(), ...segmentTails.keys()]);
      for (const agentId of agentIds) {
        const merged = tailString(`${legacyTails.get(agentId) ?? ""}${segmentTails.get(agentId) ?? ""}`, this.tailBytes);
        this.transcripts[agentId] = merged;
        this.persistedLengths.set(agentId, merged.length);
      }
    } catch {
      // directory doesn't exist yet
    }
  }

  private loadAgentSegments(agentId: AgentId): string | null {
    if (!this.dirPath) return null;
    const agentDir = this.agentDir(agentId);
    const segments = listSegmentNames(agentDir);
    if (segments.length === 0) return null;

    const segmentPaths = segments.map((segment) => path.join(agentDir, segment));
    const latest = segments[segments.length - 1];
    this.segments.set(agentId, {
      name: latest,
      bytes: fs.statSync(path.join(agentDir, latest)).size,
    });
    return tailFiles(segmentPaths, this.tailBytes);
  }

  private saveAgentChunk(agentId: AgentId, chunk: string): void {
    if (!this.dirPath || chunk.length === 0) return;
    this.pendingBuffers.set(agentId, (this.pendingBuffers.get(agentId) ?? "") + chunk);
    this.flushAgent(agentId);
  }

  private flushAgent(agentId: AgentId): void {
    if (!this.dirPath) return;
    const pending = this.pendingBuffers.get(agentId) ?? "";
    if (!pending) {
      this.clearRetry(agentId);
      return;
    }

    try {
      this.writePending(agentId, pending);
      this.pendingBuffers.delete(agentId);
      this.persistedLengths.set(agentId, (this.persistedLengths.get(agentId) ?? 0) + pending.length);
      this.warnedAgents.delete(agentId);
      this.clearRetry(agentId);
    } catch (error) {
      this.closeHandle(agentId);
      this.warnOnce(agentId, error);
      this.scheduleRetry(agentId);
    }
  }

  private writePending(agentId: AgentId, pending: string): void {
    let remaining = pending;
    while (remaining.length > 0) {
      let segment = this.currentSegment(agentId);
      if (segment.bytes >= this.maxSegmentBytes) {
        this.closeHandle(agentId);
        segment = this.nextSegment(agentId);
        this.segments.set(agentId, segment);
      }

      const capacity = Math.max(1, this.maxSegmentBytes - segment.bytes);
      const piece = takePrefixByBytes(remaining, capacity);
      const handle = this.openHandle(agentId);
      fs.writeSync(handle, piece);
      segment.bytes += Buffer.byteLength(piece);
      this.segments.set(agentId, segment);
      remaining = remaining.slice(piece.length);

      if (remaining.length > 0 && segment.bytes >= this.maxSegmentBytes) {
        this.closeHandle(agentId);
        this.segments.set(agentId, this.nextSegment(agentId));
      }
    }
  }

  private openHandle(agentId: AgentId): number {
    const existing = this.handles.get(agentId);
    if (existing !== undefined) return existing;
    if (!this.dirPath) throw new Error("Transcript directory is not configured.");
    const segment = this.currentSegment(agentId);
    const agentDir = this.agentDir(agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    const handle = fs.openSync(path.join(agentDir, segment.name), "a");
    this.handles.set(agentId, handle);
    return handle;
  }

  private currentSegment(agentId: AgentId): SegmentState {
    const current = this.segments.get(agentId);
    const today = datePrefix(this.now());
    if (current && current.name.startsWith(today) && current.bytes < this.maxSegmentBytes) {
      return current;
    }
    if (current && !current.name.startsWith(today)) {
      this.closeHandle(agentId);
      const next = { name: `${today}-0001.log`, bytes: 0 };
      this.segments.set(agentId, next);
      return next;
    }
    if (current) {
      return current;
    }

    const agentDir = this.agentDir(agentId);
    const existing = listSegmentNames(agentDir);
    if (existing.length > 0) {
      const latest = existing[existing.length - 1];
      const state = { name: latest, bytes: fs.statSync(path.join(agentDir, latest)).size };
      this.segments.set(agentId, state);
      return this.currentSegment(agentId);
    }

    const first = { name: `${today}-0001.log`, bytes: 0 };
    this.segments.set(agentId, first);
    return first;
  }

  private nextSegment(agentId: AgentId): SegmentState {
    const today = datePrefix(this.now());
    const agentDir = this.agentDir(agentId);
    const existing = listSegmentNames(agentDir).filter((name) => name.startsWith(today));
    const current = this.segments.get(agentId);
    if (current?.name.startsWith(today)) {
      existing.push(current.name);
    }
    const maxSeq = existing.reduce((max, name) => Math.max(max, Number(name.slice(11, 15)) || 0), 0);
    return { name: `${today}-${String(maxSeq + 1).padStart(4, "0")}.log`, bytes: 0 };
  }

  private closeHandle(agentId: AgentId): void {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    try {
      fs.closeSync(handle);
    } catch {
      // best effort cleanup after a write failure
    }
  }

  private scheduleRetry(agentId: AgentId): void {
    if (this.retryTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(agentId);
      this.flushAgent(agentId);
    }, RETRY_SAVE_DELAY_MS);
    timer.unref?.();
    this.retryTimers.set(agentId, timer);
  }

  private clearRetry(agentId: AgentId): void {
    const timer = this.retryTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(agentId);
  }

  private warnOnce(agentId: AgentId, error: unknown): void {
    if (this.warnedAgents.has(agentId)) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[orbit] failed to persist terminal transcript for ${agentId}: ${message}`);
    this.warnedAgents.add(agentId);
  }

  private agentDir(agentId: AgentId): string {
    if (!this.dirPath) throw new Error("Transcript directory is not configured.");
    return path.join(this.dirPath, agentId);
  }
}

function listSegmentNames(agentDir: string): string[] {
  try {
    return fs
      .readdirSync(agentDir)
      .filter((entry) => /^\d{4}-\d{2}-\d{2}-\d{4}\.log$/.test(entry))
      .sort();
  } catch {
    return [];
  }
}

function tailFiles(files: string[], maxBytes: number): string {
  const chunks: Buffer[] = [];
  let remaining = maxBytes;
  for (const file of [...files].reverse()) {
    if (remaining <= 0) break;
    const stat = safeStat(file);
    if (!stat?.isFile()) continue;
    const readBytes = Math.min(remaining, stat.size);
    const buffer = fs.readFileSync(file);
    chunks.unshift(buffer.subarray(buffer.length - readBytes));
    remaining -= readBytes;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tailString(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}

function takePrefixByBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (end > 0 && bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
    if (bytes >= maxBytes) break;
  }
  return value.slice(0, Math.max(1, end));
}

function datePrefix(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
