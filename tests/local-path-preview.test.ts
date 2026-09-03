import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PREVIEW_TEXT_LIMIT_BYTES,
  buildFilePreview,
  buildRawPreviewHeaders,
  classifyPreviewFile,
  decodePreviewText,
  rawPreviewMimeType,
  readRawPreview,
} from "../src/server/local-path-preview.ts";

test("classifyPreviewFile maps extensions onto the preview kinds", () => {
  assert.equal(classifyPreviewFile("D:/repo/README.md"), "markdown");
  assert.equal(classifyPreviewFile("D:/repo/src/App.tsx"), "text");
  assert.equal(classifyPreviewFile("D:/repo/data.json"), "text");
  assert.equal(classifyPreviewFile("D:/repo/styles.css"), "text");
  assert.equal(classifyPreviewFile("D:/repo/notes.txt"), "text");
  assert.equal(classifyPreviewFile(path.join("D:/repo", "Makefile")), "text");
  assert.equal(classifyPreviewFile(path.join("D:/repo", ".gitignore")), "text");
  assert.equal(classifyPreviewFile("D:/repo/logo.PNG"), "image", "extension matching is case-insensitive");
  assert.equal(classifyPreviewFile("D:/repo/arch.pdf"), "pdf");
  // 未知扩展名与二进制格式一律降级，安全默认。
  assert.equal(classifyPreviewFile("D:/repo/report.docx"), "binary");
  assert.equal(classifyPreviewFile("D:/repo/bundle.exe"), "binary");
  assert.equal(classifyPreviewFile(path.join("D:/repo", "archive")), "binary", "unknown extensionless file stays binary");
});

test("rawPreviewMimeType only allows whitelisted image extensions and pdf", () => {
  assert.equal(rawPreviewMimeType("D:/repo/logo.svg"), "image/svg+xml");
  assert.equal(rawPreviewMimeType("D:/repo/photo.jpeg"), "image/jpeg");
  assert.equal(rawPreviewMimeType("D:/repo/icon.ico"), "image/x-icon");
  assert.equal(rawPreviewMimeType("D:/repo/manual.PDF"), "application/pdf");
  assert.equal(rawPreviewMimeType("D:/repo/index.html"), null, "html must never be raw-previewable");
  assert.equal(rawPreviewMimeType("D:/repo/data.json"), null, "text kinds never serve raw bytes");
  assert.equal(rawPreviewMimeType("D:/repo/unknown.zzz"), null);
});

test("buildRawPreviewHeaders pins exact content type with nosniff and no-store", () => {
  const headers = buildRawPreviewHeaders("application/pdf", 1024);
  assert.equal(headers["Content-Type"], "application/pdf");
  assert.equal(headers["Content-Disposition"], "inline");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["Content-Length"], "1024");
});

test("decodePreviewText strips BOMs and tolerates invalid UTF-8", () => {
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello", "utf8")]);
  assert.equal(decodePreviewText(utf8Bom), "hello");
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你好", "utf16le")]);
  assert.equal(decodePreviewText(utf16le), "你好");
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("你好", "utf16le").swap16()]);
  assert.equal(decodePreviewText(utf16be), "你好");
  // GBK 字节不是合法 UTF-8：解码必须不抛错，替换为 U+FFFD。
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  const decoded = decodePreviewText(gbk);
  assert.ok(typeof decoded === "string");
  assert.ok(decoded.includes("\ufffd"));
});

test("buildFilePreview embeds text content with truncation flag", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preview-"));
  try {
    const file = path.join(root, "App.tsx");
    fs.writeFileSync(file, "export const x = 1;\n");
    const meta = await buildFilePreview(file);
    assert.equal(meta.kind, "text");
    assert.ok(!meta.truncated);
    assert.equal(meta.content, "export const x = 1;\n");
    assert.equal(meta.size, 20);

    const large = path.join(root, "big.log");
    const chunk = "x".repeat(64 * 1024);
    const chunkCount = Math.ceil((PREVIEW_TEXT_LIMIT_BYTES + 4096) / chunk.length);
    fs.writeFileSync(large, Buffer.from(chunk.repeat(chunkCount), "utf8"));
    const truncatedMeta = await buildFilePreview(large);
    assert.ok(truncatedMeta.kind === "text" || truncatedMeta.kind === "markdown");
    assert.ok(truncatedMeta.truncated, "file beyond the limit must be flagged");
    assert.ok(Buffer.byteLength(truncatedMeta.content, "utf8") <= PREVIEW_TEXT_LIMIT_BYTES);
    assert.ok(truncatedMeta.size > PREVIEW_TEXT_LIMIT_BYTES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildFilePreview classifies markdown, image, pdf and binary metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preview-"));
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "# 标题\n\n正文");
    const md = await buildFilePreview(path.join(root, "notes.md"));
    assert.equal(md.kind, "markdown");
    assert.ok(md.kind === "markdown" && md.content.includes("# 标题"));

    fs.writeFileSync(path.join(root, "doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    fs.writeFileSync(path.join(root, "sheet.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const pdf = await buildFilePreview(path.join(root, "doc.pdf"));
    assert.ok(pdf.kind === "pdf" && pdf.mimeType === "application/pdf");
    const xlsx = await buildFilePreview(path.join(root, "sheet.xlsx"));
    assert.equal(xlsx.kind, "binary");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readRawPreview serves whitelisted bytes and rejects other kinds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-preview-"));
  try {
    const png = path.join(root, "pixel.png");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const served = await readRawPreview(png);
    assert.ok(served.ok);
    assert.equal(served.mimeType, "image/png");
    assert.equal(served.buffer.length, 8);

    fs.writeFileSync(path.join(root, "notes.txt"), "text");
    const refused = await readRawPreview(path.join(root, "notes.txt"));
    assert.ok(!refused.ok);
    assert.equal(refused.status, 403);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
