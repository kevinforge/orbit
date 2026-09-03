import assert from "node:assert/strict";
import test from "node:test";
import { highlightCodeHtml, previewLanguageFromPath } from "../src/ui/code-highlight.ts";

test("previewLanguageFromPath maps known extensions and file names case-insensitively", () => {
  assert.equal(previewLanguageFromPath("D:\\repo\\src\\App.tsx"), "typescript");
  assert.equal(previewLanguageFromPath("/home/orbit/data.JSON"), "json");
  assert.equal(previewLanguageFromPath("~/styles.scss"), "scss");
  assert.equal(previewLanguageFromPath("D:\\web\\index.html"), "xml");
  assert.equal(previewLanguageFromPath("deploy.ps1"), "powershell");
  assert.equal(previewLanguageFromPath("config.toml"), "ini");
  assert.equal(previewLanguageFromPath("workflow.yml"), "yaml");
  assert.equal(previewLanguageFromPath("/srv/app/Dockerfile"), "dockerfile");
  assert.equal(previewLanguageFromPath("makefile"), "makefile");
});

test("previewLanguageFromPath returns null for unknown or dot-prefixed names", () => {
  assert.equal(previewLanguageFromPath("notes.txt"), null);
  assert.equal(previewLanguageFromPath(".gitignore"), null, "dot files have no usable extension");
  assert.equal(previewLanguageFromPath("Dockerfile.dev"), null, "suffixed dockerfiles are not the known file name");
  assert.equal(previewLanguageFromPath("archive.tar.gz"), null);
});

test("highlightCodeHtml escapes markup for plain text and unknown languages", () => {
  const plain = highlightCodeHtml('<img src="x">&amp;', null);
  assert.equal(plain, "&lt;img src=&quot;x&quot;&gt;&amp;amp;");
  assert.ok(!plain.includes("<span"), "plain text gets no token spans");
  // 未注册的语言 id（kotlin 不在 curated 列表）同样退回纯文本转义。
  assert.ok(!highlightCodeHtml("val x = 1", "kotlin").includes("<span"));
});

test("highlightCodeHtml emits token spans for registered languages", () => {
  const html = highlightCodeHtml('const value = "orbit";', "typescript");
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<span class="hljs-string">/);
});
