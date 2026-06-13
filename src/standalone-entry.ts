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

import { validateLicenseAsync, generateMachineId, getHardwareInfo, ensureOrbitHomeDir } from "./license/index.ts";
import path from "node:path";

async function main() {
  // Handle --machine-id flag
  if (process.argv.includes('--machine-id')) {
    const orbitHomeDir = ensureOrbitHomeDir();
    const licensePath = path.join(orbitHomeDir, "license.json");
    const machineId = await generateMachineId();
    console.log('\nOrbit 机器码');
    console.log('===========');
    console.log(`\n  ${machineId}\n`);
    console.log('下一步：');
    console.log('1. 将上面的机器码发送给管理员。');
    console.log('2. 管理员会发给你一个 license.json 文件。');
    console.log(`3. 请把 license.json 放到这个目录：${orbitHomeDir}`);
    console.log(`   最终文件路径应该是：${licensePath}`);
    console.log('4. 放好后重新执行：orbit\n');
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

  // License validation
  const orbitHomeDir = ensureOrbitHomeDir();
  const licensePath = path.join(orbitHomeDir, "license.json");
  const isValid = await validateLicenseAsync();
  if (!isValid) {
    console.error("\n[orbit] 授权校验未通过，Orbit 暂时不能启动。");
    console.error("\n首次使用请按下面步骤操作：");
    console.error("1. 执行命令获取机器码：orbit --machine-id");
    console.error("2. 将机器码发送给管理员，并向管理员获取 license.json 文件。");
    console.error(`3. 将 license.json 放到这个目录：${orbitHomeDir}`);
    console.error(`   最终文件路径应该是：${licensePath}`);
    console.error("4. 放好后重新执行：orbit\n");
    process.exit(1);
  }

  // License valid - start the server
  console.log("[orbit] 授权校验通过，正在启动 Orbit...");
  await import("./server/index.ts");
}

main().catch((err) => {
  console.error("[orbit] 启动失败：", err);
  process.exit(1);
});
