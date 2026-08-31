/**
 * Attachment download response headers.
 *
 * Images stay inline with their real MIME so composer/message previews work.
 * Every non-image kind is served as a generic download (octet-stream +
 * `Content-Disposition: attachment`) so browsers never render PDF/HTML/code
 * content in the Orbit origin. All responses carry `nosniff` so a mismatching
 * Content-Type cannot be re-interpreted by the browser.
 */
const CACHE_CONTROL = "private, max-age=86400";

/** ASCII-only, quote/backslash-free fallback for the `filename=` parameter. */
function asciiFallback(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").trim();
  return safe || "attachment";
}

export function buildContentDisposition(kind: "image" | "file", filename: string): string {
  const disposition = kind === "image" ? "inline" : "attachment";
  const fallback = asciiFallback(filename);
  if (/^[\x20-\x7e]*$/.test(filename)) {
    return `${disposition}; filename="${fallback}"`;
  }
  // RFC 5987 encoding preserves the original (non-ASCII) filename.
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function buildAttachmentHeaders(stored: {
  kind: "image" | "file";
  mimeType: string;
  filename: string;
}): Record<string, string> {
  return {
    "Content-Type": stored.kind === "image" ? stored.mimeType : "application/octet-stream",
    "Content-Disposition": buildContentDisposition(stored.kind, stored.filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": CACHE_CONTROL,
  };
}
