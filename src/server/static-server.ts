import fs from "node:fs";
import path from "node:path";
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

export function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const root = path.resolve(process.cwd(), "dist/ui");
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
