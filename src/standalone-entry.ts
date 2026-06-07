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

import { validateLicenseAsync, generateMachineId, getHardwareInfo } from "./license/index.ts";

async function main() {
  // Handle --machine-id flag
  if (process.argv.includes('--machine-id')) {
    const machineId = await generateMachineId();
    console.log('\n orbit Machine ID');
    console.log('================');
    console.log(`\n  ${machineId}\n`);
    console.log('Send this ID to get your license file.\n');
    process.exit(0);
  }

  // Handle --hardware-info flag (for debugging)
  if (process.argv.includes('--hardware-info')) {
    const [machineId, hardwareInfo] = await Promise.all([
      generateMachineId(),
      getHardwareInfo(),
    ]);
    console.log('\n Hardware Information');
    console.log('====================');
    console.log(`\n  Machine ID: ${machineId}`);
    if (hardwareInfo.mac) console.log(`  MAC:        ${hardwareInfo.mac}`);
    if (hardwareInfo.cpuId) console.log(`  CPU:        ${hardwareInfo.cpuId}`);
    if (hardwareInfo.boardUuid) console.log(`  Board UUID: ${hardwareInfo.boardUuid}`);
    console.log('');
    process.exit(0);
  }

  // License validation
  const isValid = await validateLicenseAsync();
  if (!isValid) {
    console.error("\n[orbit] License validation failed. Exiting.");
    console.error('[orbit] Run `orbit --machine-id` to get your machine ID for licensing.\n');
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
