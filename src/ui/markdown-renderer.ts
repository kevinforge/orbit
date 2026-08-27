import { marked } from "marked";

const safeProtocols = ["https:", "http:", "mailto:", "tel:"];

// GFM autolink 会把紧邻的 CJK 字符与全角标点吞进 URL（"…/a。"、
// "…/orbit了解更多"），导致打开被污染的地址。仅剥离尾随 run，被剥离的
// 字符保留为正文（issue #143）。覆盖 CJK 标点（U+3000–303F）、CJK 统一
// 表意文字（U+4E00–9FFF）与全角形式（U+FF00–FFEF）。
const trailingCjk = /[　-〿一-鿿＀-￯]+$/u;

function stripTrailingCjk(href: string): { href: string; stripped: string } {
  const match = trailingCjk.exec(href);
  if (!match) return { href, stripped: "" };
  return { href: href.slice(0, match.index), stripped: match[0] };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(href: string): string {
  try {
    const url = new URL(href, "https://placeholder.invalid");
    if (!safeProtocols.includes(url.protocol)) return "";
  } catch {
    return "";
  }
  return href;
}

// --- 本地路径入口（issue #143）---
// 消息里的本地路径（X:/、X:\、~/、/ 开头，含 file:/// 前缀）不是可导航的
// Web URL：交给 sanitizeUrl 会被当成占位域下的站内相对链接。这里在 sanitize
// 之前分流，渲染成带 data-path 的 span，由 App 层的点击委托调用
// /api/local-path/reveal 在系统资源管理器中定位。只动渲染层，不改消息存储。
export const LOCAL_PATH_LINK_CLASS = "localPathLink";

function renderLocalPathEntry(path: string, text: string): string {
  return `<span class="${LOCAL_PATH_LINK_CLASS}" data-path="${escapeHtml(path)}" role="button" tabindex="0" title="在系统资源管理器中定位">${escapeHtml(text)}</span>`;
}

// file:///D:/x 与 file:///home/x 都剥掉 file:// 前缀；file://host/ 形式指向
// 远程主机，不识别。
function localPathFromHref(href: string): string | null {
  let candidate = href;
  if (/^file:\/\//i.test(candidate)) {
    if (!/^file:\/\/\//i.test(candidate)) return null;
    candidate = candidate.replace(/^file:\/\//i, "");
    // file:///D:/x 剥完是 "/D:/x"，去掉前导斜杠还原盘符路径。
    if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
  }
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return candidate;
  if (/^~[\\/]/.test(candidate)) return candidate;
  // POSIX 绝对路径：显式写出的链接意图明确，单段（/tmp）也接受。
  if (/^\/[^\s]/.test(candidate)) return candidate;
  return null;
}

// 裸路径（无 markdown 链接语法包裹）用 inline tokenizer 扩展识别。字符集
// 限定可见 ASCII 且排除反引号，避免吞掉 CJK 正文（路径与中文正文之间通常
// 无空格）和 code span；"/" 开头额外要求至少两段，避免把正文里的 and/or、
// 单段 URL 路径切成入口。
const pathChars = "[^\\s`\\u0080-\\uffff]";
const bareLocalPath = new RegExp(
  `^(?:[A-Za-z]:[\\\\/]${pathChars}+|~[\\\\/]${pathChars}+|/${pathChars}+(/${pathChars}+)+)`,
);
// 路径末尾紧邻的半角标点属于正文而非路径（"…/App.tsx."、"…/a.txt),"）。
const trailingPunctuation = /[.,;:!?)>'"]+$/;

const localPathLinkExtension = {
  name: "localPathLink",
  level: "inline" as const,
  start(src: string): number | undefined {
    const match = new RegExp(`[A-Za-z]:[\\\\/]|~[\\\\/]|/${pathChars}+/`).exec(src);
    return match?.index;
  },
  tokenizer(src: string) {
    const match = bareLocalPath.exec(src);
    if (!match) return undefined;
    const trimmed = match[0].replace(trailingPunctuation, "");
    // 剥掉尾随标点后可能只剩 "D:/" 之类的残段，重新校验避免生成坏入口。
    if (!bareLocalPath.test(trimmed)) return undefined;
    return { type: "localPathLink", raw: trimmed, tokens: [], path: trimmed };
  },
  renderer(token: { path: string }): string {
    return renderLocalPathEntry(token.path, token.path);
  },
};

marked.use({
  extensions: [localPathLinkExtension],
  renderer: {
    html({ text }: { text: string }): string {
      return escapeHtml(text);
    },
    link({ href, text }: { href: string; text: string }): string {
      const localPath = localPathFromHref(href);
      if (localPath !== null) {
        return renderLocalPathEntry(localPath, text);
      }
      const { href: cleanHref, stripped } = stripTrailingCjk(href);
      const safeHref = sanitizeUrl(cleanHref);
      // autolink 的链接文本就是原始 URL（含被吞入的 CJK），与 href 同步剥离；
      // 显式 [文本](url) 的文本保持用户原样。被剥离字符拼回正文流。
      const linkText = text === href ? cleanHref : text;
      if (!safeHref) {
        return `${escapeHtml(linkText)}${escapeHtml(stripped)}`;
      }
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a>${escapeHtml(stripped)}`;
    },
    image({ href, text }: { href: string; text: string }): string {
      const safeHref = sanitizeUrl(href);
      if (!safeHref) return escapeHtml(text);
      return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}" />`;
    },
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang || "";
      const langLabel = language ? `<span class="codeLang">${escapeHtml(language)}</span>` : "";
      return `<div class="codeBlock"><div class="codeHeader">${langLabel}<button class="codeCopyBtn" type="button" onclick="(function(btn){var c=btn.closest('.codeBlock').querySelector('code');navigator.clipboard.writeText(c.textContent);btn.textContent='✓';btn.classList.add('copied');setTimeout(function(){btn.textContent='Copy';btn.classList.remove('copied');},1500)})(this)">Copy</button></div><pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}
