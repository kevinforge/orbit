import { Transform, type TransformCallback } from "node:stream";

export const DEFAULT_ACP_FRAME_LIMIT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_ACP_STDERR_LIMIT_BYTES = 64 * 1024;

export class AcpFrameLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`ACP response frame exceeded the ${formatBytes(limitBytes)} safety limit.`);
    this.name = "AcpFrameLimitError";
  }
}

/** Counts bytes between newlines without imposing a limit on total run output. */
export function createAcpFrameLimitTransform(
  limitBytes = DEFAULT_ACP_FRAME_LIMIT_BYTES,
): Transform {
  let currentFrameBytes = 0;
  return new Transform({
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let segmentStart = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        currentFrameBytes += index - segmentStart;
        if (currentFrameBytes > limitBytes) {
          callback(new AcpFrameLimitError(limitBytes));
          return;
        }
        currentFrameBytes = 0;
        segmentStart = index + 1;
      }
      currentFrameBytes += buffer.length - segmentStart;
      if (currentFrameBytes > limitBytes) {
        callback(new AcpFrameLimitError(limitBytes));
        return;
      }
      callback(null, buffer);
    },
  });
}

export class BoundedTextTail {
  private tail = Buffer.alloc(0);

  constructor(private readonly limitBytes = DEFAULT_ACP_STDERR_LIMIT_BYTES) {}

  append(value: string): void {
    const chunk = Buffer.from(value, "utf8");
    if (chunk.length >= this.limitBytes) {
      this.tail = chunk.subarray(chunk.length - this.limitBytes);
      return;
    }
    const next = Buffer.concat([this.tail, chunk]);
    this.tail = next.length <= this.limitBytes
      ? next
      : next.subarray(next.length - this.limitBytes);
  }

  text(): string {
    let start = 0;
    while (start < this.tail.length && (this.tail[start]! & 0xc0) === 0x80) {
      start += 1;
    }
    return this.tail.subarray(start).toString("utf8");
  }

  reset(): void {
    this.tail = Buffer.alloc(0);
  }
}

/**
 * Forwards process stderr to the user under a per-connection byte budget.
 *
 * `reset()` is called on pool rebind so a reused process starts fresh: without
 * it, a prior lease that already hit the truncation limit would silently
 * swallow every subsequent lease's stderr, and the tail would keep mixing in
 * diagnostics from the previous run.
 */
export class AcpStderrForwarder {
  private readonly tail: BoundedTextTail;
  private forwardedBytes = 0;
  private truncated = false;

  constructor(private readonly limitBytes = DEFAULT_ACP_STDERR_LIMIT_BYTES) {
    this.tail = new BoundedTextTail(limitBytes);
  }

  /** Returns the user-facing strings to emit for one decoded stderr chunk. */
  forward(readable: string): string[] {
    const emits: string[] = [];
    this.tail.append(readable);
    if (this.truncated) return emits;
    const remainingBytes = this.limitBytes - this.forwardedBytes;
    if (remainingBytes <= 0) {
      this.truncated = true;
      emits.push("\n[ACP stderr output truncated]\n");
      return emits;
    }
    const visible = takeUtf8Prefix(readable, remainingBytes);
    if (visible) {
      this.forwardedBytes += Buffer.byteLength(visible);
      emits.push(visible);
    }
    if (visible.length < readable.length) {
      this.truncated = true;
      emits.push("\n[ACP stderr output truncated]\n");
    }
    return emits;
  }

  reset(): void {
    this.tail.reset();
    this.forwardedBytes = 0;
    this.truncated = false;
  }

  tailText(): string {
    return this.tail.text();
  }
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} byte${value === 1 ? "" : "s"}`;
}
