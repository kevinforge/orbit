import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// Resolve dist/ui/ relative to the package root, not CWD.
// In production, ORBIT_DIST_UI is set by bin/orbit.js. In dev, fall back to
// the source-relative path (import.meta.url → src/server/ → ../../dist/ui).
// For standalone builds, ORBIT_UI_DIR can be set externally.
const DIST_UI_ROOT =
  process.env.ORBIT_DIST_UI ??
  process.env.ORBIT_UI_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "ui");

export function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const root = DIST_UI_ROOT;
  const pathname = decodeURIComponent(urlPath);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(root, `.${requested}`);

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
    return false;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const contentType = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
