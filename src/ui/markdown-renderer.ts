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

marked.use({
  renderer: {
    html({ text }: { text: string }): string {
      return escapeHtml(text);
    },
    link({ href, text }: { href: string; text: string }): string {
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
