import type { ReactNode } from "react";

export type MarkdownBlock = {
  type: "heading" | "list" | "table" | "paragraph" | "code_block" | "hr";
  level?: number;
  lang?: string;
  code?: string;
  rows?: string[][];
  items?: string[];
  text?: string;
};

export function parseMarkdown(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 4), text: heading[2] });
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code_block", lang: lang || undefined, code: codeLines.join("\n") });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? "").trim())) {
        items.push((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (looksLikeTableRow(trimmed)) {
      const rows: string[][] = [];
      while (index < lines.length && looksLikeTableRow((lines[index] ?? "").trim())) {
        const row = (lines[index] ?? "").trim();
        if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(row)) {
          rows.push(splitTableRow(row));
        }
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? "").trim();
      if (!current || /^(#{1,6})\s+/.test(current) || /^[-*]\s+/.test(current) || looksLikeTableRow(current) || current.startsWith("```") || /^(-{3,}|\*{3,}|_{3,})$/.test(current)) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2;
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}
