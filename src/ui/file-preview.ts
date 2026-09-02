/**
 * Pure helpers for the local file preview panel (issue #165).
 *
 * Kept free of React and DOM access so behavior stays testable under
 * node:test without a DOM.
 */

export type FilePreviewMeta =
  | { ok: true; kind: "directory"; target: string }
  | { ok: true; kind: "text" | "markdown"; target: string; size: number; truncated: boolean; content: string }
  | { ok: true; kind: "image" | "pdf"; target: string; size: number; mimeType: string }
  | { ok: true; kind: "binary"; target: string; size: number };

export function buildPreviewMetadataUrl(path: string): string {
  return `/api/local-path/preview?path=${encodeURIComponent(path)}`;
}

export function buildPreviewRawUrl(path: string): string {
  return `/api/local-path/preview/raw?path=${encodeURIComponent(path)}`;
}

/** Display name for the panel title: the final path segment. */
export function previewFileName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const segment = normalized.split(/[\\/]/).filter(Boolean).pop();
  return segment ?? path;
}

/**
 * Pretty-print JSON text for the panel. Returns null when the content is not
 * parseable (or was truncated) so the caller falls back to the raw text.
 */
export function prettifyJsonText(path: string, content: string, truncated: boolean): string | null {
  if (truncated) return null;
  if (!/\.(json|jsonc)$/i.test(path)) return null;
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  } catch {
    return null;
  }
}

/** Human-readable byte size for the panel hints. */
export function formatPreviewSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
