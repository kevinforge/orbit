import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Resolve an Orbit-bundled executable before falling back to a user override or PATH. */
export function resolveBundledCommand(
  executableName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const roots = [
    env.ORBIT_PACKAGE_ROOT?.trim(),
    SOURCE_ROOT,
    path.resolve(path.dirname(process.execPath), ".."),
    path.resolve(path.dirname(process.execPath), "../.."),
  ].filter((root): root is string => Boolean(root));
  const suffix = process.platform === "win32" ? ".cmd" : "";

  for (const root of [...new Set(roots)]) {
    const candidate = path.join(root, "node_modules", ".bin", `${executableName}${suffix}`);
    if (fs.existsSync(candidate)) return candidate;
  }

  return executableName;
}
