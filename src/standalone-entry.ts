/**
 * Standalone entry point for Orbit.
 *
 * This file is used when building a standalone executable with Bun compile.
 *
 * Usage:
 *   bun build ./src/standalone-entry.ts --compile --bytecode --minify --sourcemap=none --outfile=orbit.exe
 *
 * When running the standalone binary:
 *   - Set ORBIT_UI_DIR=/path/to/ui/assets to specify UI asset location
 *   - Or place UI assets in ./dist/ui/ relative to the binary
 */

import { validateLicenseAsync, generateMachineId, getHardwareInfo, ensureOrbitHomeDir } from "./license/index.ts";
import path from "node:path";

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Orbit - local-first collaboration workspace for CLI-backed digital employees");
    console.log("");
    console.log("Usage:");
    console.log("  orbit              Start Orbit");
    console.log("  orbit --help       Show this help");
    console.log("  orbit --machine-id Print a machine id for private licensed builds");
    console.log("  orbit --hardware-info Print hardware info for diagnostics");
    console.log("");
    console.log("Environment:");
    console.log("  ORBIT_PORT=4317");
    console.log("  ORBIT_UI_DIR=/path/to/dist/ui");
    process.exit(0);
  }

  // Handle --machine-id flag
  if (process.argv.includes('--machine-id')) {
    const orbitHomeDir = ensureOrbitHomeDir();
    const licensePath = path.join(orbitHomeDir, "license.json");
    const machineId = await generateMachineId();
    console.log('\nOrbit machine id');
    console.log('================');
    console.log(`\n  ${machineId}\n`);
    console.log('This command is only needed for private licensed builds.');
    console.log(`License directory: ${orbitHomeDir}`);
    console.log(`License path:      ${licensePath}\n`);
    process.exit(0);
  }

  // Handle --hardware-info flag (for debugging)
  if (process.argv.includes('--hardware-info')) {
    const [machineId, hardwareInfo] = await Promise.all([
      generateMachineId(),
      getHardwareInfo(),
    ]);
    console.log('\n硬件信息');
    console.log('=======');
    console.log(`\n  机器码: ${machineId}`);
    if (hardwareInfo.mac) console.log(`  MAC:        ${hardwareInfo.mac}`);
    if (hardwareInfo.cpuId) console.log(`  CPU:        ${hardwareInfo.cpuId}`);
    if (hardwareInfo.boardUuid) console.log(`  Board UUID: ${hardwareInfo.boardUuid}`);
    console.log('');
    process.exit(0);
  }

  if (process.env.ORBIT_REQUIRE_LICENSE === "true") {
    const orbitHomeDir = ensureOrbitHomeDir();
    const licensePath = path.join(orbitHomeDir, "license.json");
    const isValid = await validateLicenseAsync();
    if (!isValid) {
      console.error("\n[orbit] License validation failed; Orbit cannot start.");
      console.error("\nFor private licensed builds:");
      console.error("1. Run: orbit --machine-id");
      console.error("2. Request license.json from the distributor.");
      console.error(`3. Place license.json in: ${orbitHomeDir}`);
      console.error(`   Expected path: ${licensePath}`);
      console.error("4. Run orbit again.\n");
      process.exit(1);
    }
    console.log("[orbit] License validation passed.");
  }

  await import("./server/index.ts");
}

main().catch((err) => {
  console.error("[orbit] Failed to start:", err);
  process.exit(1);
});
