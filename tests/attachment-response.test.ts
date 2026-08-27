import assert from "node:assert/strict";
import test from "node:test";

import { buildAttachmentHeaders, buildContentDisposition } from "../src/server/attachment-response.ts";

test("images stay inline with their real MIME type", () => {
  const headers = buildAttachmentHeaders({ kind: "image", mimeType: "image/png", filename: "shot.png" });
  assert.equal(headers["Content-Type"], "image/png");
  assert.equal(headers["Content-Disposition"], 'inline; filename="shot.png"');
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("non-image attachments download as generic octet-stream", () => {
  for (const [mimeType, filename] of [
    ["application/pdf", "spec.pdf"],
    ["text/plain", "index.ts"],
    ["text/markdown", "README.md"],
  ] as const) {
    const headers = buildAttachmentHeaders({ kind: "file", mimeType, filename });
    assert.equal(headers["Content-Type"], "application/octet-stream", filename);
    assert.match(headers["Content-Disposition"] ?? "", /^attachment/, filename);
    assert.equal(headers["X-Content-Type-Options"], "nosniff", filename);
  }
});

test("non-ASCII filenames use an ASCII fallback plus RFC 5987 encoding", () => {
  const disposition = buildContentDisposition("file", "规格说明.pdf");
  assert.match(disposition, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  // Encoded form must round-trip the original filename.
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)$/)?.[1] ?? "";
  assert.equal(decodeURIComponent(encoded), "规格说明.pdf");
});

test("header-breaking characters are neutralized in filenames", () => {
  const malicious = 'evil"; CRLF-injection' + String.fromCharCode(13, 10) + ".txt";
  const disposition = buildContentDisposition("file", malicious);
  assert.ok(!disposition.includes("\r"), "CR must not reach the header");
  assert.ok(!disposition.includes("\n"), "LF must not reach the header");
  // The quoted fallback must be one closed run: no embedded quote can escape it.
  const quoted = disposition.match(/filename="([^"]*)"/);
  assert.ok(quoted, "must contain a quoted fallback filename");
  assert.equal(disposition.split('"').length - 1, 2, "exactly one quoted pair is allowed");
});
