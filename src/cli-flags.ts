/**
 * CLI flag helpers for the standalone entry point.
 *
 * Kept free of side effects so tests can import this module without
 * booting the server.
 */

import orbitPackageJson from "../package.json";

/**
 * Detect a `--version` / `-v` request in the raw argv list.
 */
export function isVersionRequest(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}

/**
 * Return the Orbit version declared in `package.json`.
 *
 * The standalone build bundles this module, so Bun inlines the imported
 * value into the binary at build time; no version constant is hardcoded.
 */
export function getOrbitVersion(): string {
  return orbitPackageJson.version;
}
