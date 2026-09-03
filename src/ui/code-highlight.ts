/**
 * 预览面板的代码语法高亮（issue #165 跟进）。
 *
 * 只注册常用语言子集（highlight.js core + 显式语言表），避免引入
 * lib/common 的全量语法；纯函数模块，行为可在 node:test 下直接验证。
 * hljs 的输出自带 HTML 转义，可安全用于 dangerouslySetInnerHTML。
 */
import hljs from "highlight.js/lib/core";
import { previewFileName } from "./file-preview.ts";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, grammar] of Object.entries({
  bash, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json,
  makefile, markdown, php, plaintext, powershell, python, ruby, rust, scss,
  sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, grammar);
}

/** 扩展名（小写，不含点）到 hljs 语言名的映射。 */
const extensionLanguages = new Map([
  ["ts", "typescript"], ["tsx", "typescript"],
  ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["json", "json"], ["jsonc", "json"],
  ["css", "css"], ["scss", "scss"],
  ["html", "xml"], ["htm", "xml"], ["xml", "xml"], ["svg", "xml"], ["vue", "xml"],
  ["py", "python"], ["java", "java"], ["go", "go"], ["rs", "rust"],
  ["c", "cpp"], ["h", "cpp"], ["cpp", "cpp"], ["cc", "cpp"], ["hpp", "cpp"], ["hh", "cpp"],
  ["cs", "csharp"],
  ["sh", "bash"], ["bash", "bash"], ["zsh", "bash"],
  ["ps1", "powershell"],
  ["yml", "yaml"], ["yaml", "yaml"],
  ["toml", "ini"], ["ini", "ini"], ["cfg", "ini"], ["conf", "ini"], ["properties", "ini"],
  ["sql", "sql"], ["rb", "ruby"], ["php", "php"],
  ["diff", "diff"], ["patch", "diff"],
  ["md", "markdown"], ["mdx", "markdown"],
]);

/** 无扩展名的常见文件名（小写）到 hljs 语言名的映射。 */
const fileNameLanguages = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
]);

/**
 * 从路径推断预览高亮语言。返回 null 表示按纯文本渲染（不做猜测式
 * 自动检测，保证同一文件每次预览的着色确定一致）。
 */
export function previewLanguageFromPath(path: string): string | null {
  const name = previewFileName(path).toLowerCase();
  const byName = fileNameLanguages.get(name);
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null; // 无扩展名或以点开头/结尾
  return extensionLanguages.get(name.slice(dot + 1)) ?? null;
}

/** 高亮代码并返回安全的 HTML 片段；language 为 null 或未注册时按纯文本转义。 */
export function highlightCodeHtml(code: string, language: string | null): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  }
  return hljs.highlight(code, { language: "plaintext", ignoreIllegals: true }).value;
}
