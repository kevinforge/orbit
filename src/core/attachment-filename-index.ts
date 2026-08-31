import fs from "node:fs";
import path from "node:path";

/**
 * 永久附件的展示文件名索引（PR #147 审查修复）。
 *
 * 落盘文件名是 `<id>.<ext>`，用户原始文件名只存在于消息历史里。下载时要
 * 还原原始名，若每次都走 `MessageStore.attachmentFilename()` 会把整个会话
 * 的历史分片同步读进内存（实测长对话单次上百毫秒，一条多图消息会阻塞
 * 事件循环）。该索引把 `id -> 展示文件名` 单独存成小文件，下载只读它；
 * 早于索引的历史附件扫描到一次后回填，之后不再扫描。
 *
 * 读写都是同步的：`history-retention.ts` 整体同步，且索引只有几 KB，
 * 相比原先读取全部历史分片可以忽略。
 */
export const ATTACHMENT_FILENAME_INDEX_FILE = "index.json";

export type AttachmentFilenameIndex = Record<string, string>;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function readAttachmentFilenameIndex(attachmentsDir: string): AttachmentFilenameIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(attachmentsDir, ATTACHMENT_FILENAME_INDEX_FILE), "utf8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const source = parsed as Record<string, unknown>;
  const index: AttachmentFilenameIndex = {};
  for (const id of Object.keys(source)) {
    if (UNSAFE_KEYS.has(id)) continue;
    const filename = source[id];
    if (typeof filename === "string" && filename) index[id] = filename;
  }
  return index;
}

/** 原子替换索引文件（tmp + rename），与 `~/.orbit` 其它写入保持一致。 */
export function writeAttachmentFilenameIndex(attachmentsDir: string, index: AttachmentFilenameIndex): void {
  const target = path.join(attachmentsDir, ATTACHMENT_FILENAME_INDEX_FILE);
  try {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    // best effort：索引只是下载名的加速路径，写失败时回落到历史扫描。
  }
}
