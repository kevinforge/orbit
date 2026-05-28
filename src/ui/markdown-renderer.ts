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
  },
});

export function renderMarkdown(content: string): string {
  return marked.parse(content, { async: false }) as string;
}
