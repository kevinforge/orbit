import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreviewMetadataUrl,
  buildPreviewRawUrl,
  formatPreviewSize,
  previewFileName,
  prettifyJsonText,
} from "../src/ui/file-preview.ts";

test("preview urls encode the raw path as a single query parameter", () => {
  assert.equal(
    buildPreviewMetadataUrl("D:\\repo\\我的文件 notes.md"),
    "/api/local-path/preview?path=D%3A%5Crepo%5C%E6%88%91%E7%9A%84%E6%96%87%E4%BB%B6%20notes.md",
  );
  assert.equal(
    buildPreviewRawUrl("/home/orbit/a b.png"),
    "/api/local-path/preview/raw?path=%2Fhome%2Forbit%2Fa%20b.png",
  );
  // 解码后仍能还原原始路径（Windows 盘符与反斜杠不被 URL 结构破坏）。
  const url = new URL(buildPreviewMetadataUrl("D:\\x\\y.txt:12"), "https://orbit.local");
  assert.equal(url.searchParams.get("path"), "D:\\x\\y.txt:12");
});

test("previewFileName extracts the final segment across separators", () => {
  assert.equal(previewFileName("D:\\repo\\src\\App.tsx"), "App.tsx");
  assert.equal(previewFileName("/home/orbit/notes.md"), "notes.md");
  assert.equal(previewFileName("D:\\repo\\dir\\"), "dir", "trailing separators are ignored");
  assert.equal(previewFileName("~/config.yml"), "config.yml");
  assert.equal(previewFileName("standalone-name"), "standalone-name");
});

test("prettifyJsonText only pretty-prints complete parseable json files", () => {
  assert.equal(prettifyJsonText("D:\\repo\\data.json", '{"a":1}', false), '{\n  "a": 1\n}\n');
  assert.equal(prettifyJsonText("D:\\repo\\data.json", '{"a":1}', true), null, "truncated content is never re-serialized");
  assert.equal(prettifyJsonText("D:\\repo\\data.json", "{broken", false), null);
  assert.equal(prettifyJsonText("D:\\repo\\notes.md", '{"a":1}', false), null, "non-json paths stay untouched");
});

test("formatPreviewSize renders human byte sizes", () => {
  assert.equal(formatPreviewSize(0), "0 B");
  assert.equal(formatPreviewSize(512), "512 B");
  assert.equal(formatPreviewSize(2048), "2.0 KB");
  assert.equal(formatPreviewSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatPreviewSize(Number.NaN), "");
});
