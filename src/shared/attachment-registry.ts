/**
 * Single source of truth for allowed attachment extensions.
 *
 * Every extension maps to its attachment kind, canonical MIME type, and a
 * display label used in agent prompts and UI chips. The attachment store
 * derives its whitelist from this table; the UI derives the file-picker
 * `accept` attribute from it. Image content is additionally verified by magic
 * numbers at upload; PDF must start with `%PDF-`; plain text/code types have
 * no stable magic number, so they rely on the extension whitelist plus size.
 */
export type AttachmentExtensionSpec = {
  kind: "image" | "file";
  mimeType: string;
  /** Human-readable type label for attachment chips and agent prompts. */
  label: string;
};

export const ATTACHMENT_EXTENSION_SPECS: Readonly<Record<string, AttachmentExtensionSpec>> = {
  // Images (magic-number verified)
  png: { kind: "image", mimeType: "image/png", label: "PNG" },
  jpg: { kind: "image", mimeType: "image/jpeg", label: "JPEG" },
  webp: { kind: "image", mimeType: "image/webp", label: "WebP" },

  // Documents
  pdf: { kind: "file", mimeType: "application/pdf", label: "PDF" },
  txt: { kind: "file", mimeType: "text/plain", label: "Text" },
  md: { kind: "file", mimeType: "text/markdown", label: "Markdown" },
  markdown: { kind: "file", mimeType: "text/markdown", label: "Markdown" },

  // Code
  ts: { kind: "file", mimeType: "text/plain", label: "TypeScript" },
  tsx: { kind: "file", mimeType: "text/plain", label: "TypeScript JSX" },
  js: { kind: "file", mimeType: "text/plain", label: "JavaScript" },
  jsx: { kind: "file", mimeType: "text/plain", label: "JavaScript JSX" },
  mjs: { kind: "file", mimeType: "text/plain", label: "JavaScript module" },
  cjs: { kind: "file", mimeType: "text/plain", label: "JavaScript module" },
  py: { kind: "file", mimeType: "text/plain", label: "Python" },
  go: { kind: "file", mimeType: "text/plain", label: "Go" },
  java: { kind: "file", mimeType: "text/plain", label: "Java" },
  c: { kind: "file", mimeType: "text/plain", label: "C" },
  h: { kind: "file", mimeType: "text/plain", label: "C header" },
  cc: { kind: "file", mimeType: "text/plain", label: "C++" },
  cpp: { kind: "file", mimeType: "text/plain", label: "C++" },
  hpp: { kind: "file", mimeType: "text/plain", label: "C++ header" },
  cs: { kind: "file", mimeType: "text/plain", label: "C#" },
  rs: { kind: "file", mimeType: "text/plain", label: "Rust" },
  kt: { kind: "file", mimeType: "text/plain", label: "Kotlin" },
  swift: { kind: "file", mimeType: "text/plain", label: "Swift" },
  rb: { kind: "file", mimeType: "text/plain", label: "Ruby" },
  php: { kind: "file", mimeType: "text/plain", label: "PHP" },

  // Web / config
  html: { kind: "file", mimeType: "text/plain", label: "HTML" },
  css: { kind: "file", mimeType: "text/plain", label: "CSS" },
  scss: { kind: "file", mimeType: "text/plain", label: "SCSS" },
  less: { kind: "file", mimeType: "text/plain", label: "Less" },
  vue: { kind: "file", mimeType: "text/plain", label: "Vue" },
  svelte: { kind: "file", mimeType: "text/plain", label: "Svelte" },
  json: { kind: "file", mimeType: "text/plain", label: "JSON" },
  jsonc: { kind: "file", mimeType: "text/plain", label: "JSONC" },
  yaml: { kind: "file", mimeType: "text/plain", label: "YAML" },
  yml: { kind: "file", mimeType: "text/plain", label: "YAML" },
  toml: { kind: "file", mimeType: "text/plain", label: "TOML" },
  xml: { kind: "file", mimeType: "text/plain", label: "XML" },
  sql: { kind: "file", mimeType: "text/plain", label: "SQL" },
  graphql: { kind: "file", mimeType: "text/plain", label: "GraphQL" },
  gql: { kind: "file", mimeType: "text/plain", label: "GraphQL" },
  proto: { kind: "file", mimeType: "text/plain", label: "Protocol Buffers" },
};

/**
 * Own-property spec lookup. Plain bracket access would treat inherited keys
 * such as `constructor` or `__proto__` as valid extensions (letting arbitrary
 * bytes pass validation with missing MIME metadata), so every lookup must go
 * through this guard.
 */
export function attachmentExtensionSpec(ext: string): AttachmentExtensionSpec | undefined {
  return Object.hasOwn(ATTACHMENT_EXTENSION_SPECS, ext)
    ? ATTACHMENT_EXTENSION_SPECS[ext]
    : undefined;
}

/** Lowercased extension (without the dot) or null when absent/unknown. */
export function knownAttachmentExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return attachmentExtensionSpec(ext) ? ext : null;
}

/** `accept` value for a file input covering every allowed extension. */
export function attachmentAcceptAttribute(): string {
  return Object.keys(ATTACHMENT_EXTENSION_SPECS).map((ext) => `.${ext}`).join(",");
}
