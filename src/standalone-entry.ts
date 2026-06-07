/**
 * Standalone entry point for Orbit.
 *
 * This file is used when building a standalone executable with Bun compile.
 * It validates the license before starting the main server.
 *
 * Usage:
 *   bun build ./src/standalone-entry.ts --compile --bytecode --minify --sourcemap=none --outfile=orbit.exe
 *
 * When running the standalone binary:
 *   - Set ORBIT_UI_DIR=/path/to/ui/assets to specify UI asset location
 *   - Or place UI assets in ./dist/ui/ relative to the binary
 *   - Place license.json in ./license.json or ~/.orbit/license.json
 */

import { validateLicenseAsync } from "./license/index.ts";

async function main() {
  // License validation
  const isValid = await validateLicenseAsync();
  if (!isValid) {
    console.error("\n[orbit] License validation failed. Exiting.");
    process.exit(1);
  }

  // License valid - start the server
  console.log("[orbit] License validated successfully.");
  await import("./server/index.ts");
}

main().catch((err) => {
  console.error("[orbit] Fatal error:", err);
  process.exit(1);
});
