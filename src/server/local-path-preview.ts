/**
 * Read-only local file preview for the message path entries (issue #165).
 *
 * The preview routes reuse `resolveRevealTarget` from local-path-reveal.ts so
 * `~` expansion, `:line:col` stripping, `realpath` resolution, and the
 * workspace boundary check stay identical to the reveal flow. Content types
 * come from an extension whitelist — never sniffed — and every response
 * carries `nosniff` so the browser cannot reinterpret the payload.
 */
import fs from "node:fs";
import path from "node:path";

export type FilePreviewKind = "text" | "markdown" | "image" | "pdf" | "binary";

export type FilePreviewMeta =
  | { kind: "text"; target: string; size: number; truncated: boolean; content: string }
  | { kind: "markdown"; target: string; size: number; truncated: boolean; content: string }
  | { kind: "image"; target: string; size: number; mimeType: string }
  | { kind: "pdf"; target: string; size: number; mimeType: string }
  | { kind: "binary"; target: string; size: number };

/** Text previews embed at most the first 1 MB of the file. */
export const PREVIEW_TEXT_LIMIT_BYTES = 1_000_000;

/** Raw byte previews (image/pdf) refuse files larger than 32 MB. */
export const PREVIEW_RAW_LIMIT_BYTES = 32 * 1024 * 1024;

// 代码与配置文件按扩展名白名单预览为纯文本；未列出的扩展名一律按二进制
// 处理（安全默认），面板给出提示与定位入口。
const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".log",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ".css", ".scss", ".less",
  ".html", ".htm", ".xml",
  ".md", ".markdown",
  ".csv", ".tsv", ".sql",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".gradle",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cs", ".php", ".swift", ".dart", ".lua", ".r",
  ".gitmodules",
]);

// path.extname 对点文件（.gitignore）和无扩展名常见文件（Makefile）返回
// 空串，按文件名识别为文本。
const TEXT_FILENAMES = new Set([
  "makefile", "dockerfile", "license", "licence", "notice", "codeowners",
  ".gitignore", ".gitattributes", ".dockerignore", ".npmrc", ".nvmrc",
  ".browserslistrc", ".editorconfig", ".prettierrc", ".eslintrc", ".babelrc",
  ".env", ".env.local", ".env.example",
]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

// Raw 预览只放行图片与 PDF：MIME 由扩展名白名单映射出精确值，绝不送
// text/html。SVG 通过 <img> 加载时脚本不执行；PDF 是用户确认的策略放宽
// （issue #165），仅此路由 inline，附件下载策略不变。
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const PDF_MIME = "application/pdf";

function basenameLower(target: string): string {
  return path.basename(target).toLowerCase();
}

/** Classify a resolved file by extension. Unknown extensions stay binary. */
export function classifyPreviewFile(target: string): FilePreviewKind {
  const ext = path.extname(target).toLowerCase();
  const name = basenameLower(target);
  if (ext === ".pdf") return "pdf";
  if (ext in IMAGE_MIME_BY_EXTENSION) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(name)) return "text";
  return "binary";
}

/** Exact Content-Type for raw byte previews, or null when raw serving is not allowed. */
export function rawPreviewMimeType(target: string): string | null {
  const ext = path.extname(target).toLowerCase();
  if (ext === ".pdf") return PDF_MIME;
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null;
}

// Node 的 utf-8 解码把非法字节替换为 U+FFFD，GBK 等非 UTF-8 文本不会崩
// 溃；UTF-8/UTF-16 BOM 在此显式剥离，UTF-16 内容转码为字符串。
export function decodePreviewText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

/**
 * Build the metadata (and for text kinds the truncated content) for a
 * resolved in-workspace file. The caller has already validated the path via
 * `resolveRevealTarget`; directories must be handled by the caller.
 */
export async function buildFilePreview(target: string): Promise<FilePreviewMeta> {
  const stats = await fs.promises.stat(target);
  const kind = classifyPreviewFile(target);
  if (kind === "image" || kind === "pdf") {
    return { kind, target, size: stats.size, mimeType: rawPreviewMimeType(target)! };
  }
  if (kind === "binary") {
    return { kind, target, size: stats.size };
  }
  const handle = await fs.promises.open(target, "r");
  try {
    const length = Math.min(stats.size, PREVIEW_TEXT_LIMIT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return {
      kind,
      target,
      size: stats.size,
      truncated: stats.size > length,
      content: decodePreviewText(buffer),
    };
  } finally {
    await handle.close();
  }
}

/** Response headers for raw byte previews: exact MIME, inline, nosniff, no store. */
export function buildRawPreviewHeaders(mimeType: string, contentLength: number): Record<string, string> {
  return {
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

/** Read raw preview bytes for image/pdf files, enforcing the raw size limit. */
export async function readRawPreview(
  target: string,
): Promise<{ ok: true; buffer: Buffer; mimeType: string } | { ok: false; status: 403 | 413; message: string }> {
  const mimeType = rawPreviewMimeType(target);
  if (!mimeType) {
    return { ok: false, status: 403, message: "该文件类型不支持字节预览，仅图片与 PDF 可直接展示。" };
  }
  const stats = await fs.promises.stat(target);
  if (stats.size > PREVIEW_RAW_LIMIT_BYTES) {
    return { ok: false, status: 413, message: "文件过大（超过 32 MB），不支持在线预览。" };
  }
  return { ok: true, buffer: await fs.promises.readFile(target), mimeType };
}
