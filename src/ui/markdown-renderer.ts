import { marked } from "marked";

const safeProtocols = ["https:", "http:", "mailto:", "tel:"];

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
      const safeHref = sanitizeUrl(href);
      return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
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
