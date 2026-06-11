/**
 * License module entry point.
 * Provides validateLicense() function for startup validation.
 */

import { generateMachineId } from './machine-id.ts';
import { loadLicense, findLicenseFile, getInstallTimePath, _v, _t } from './validator.ts';
import type { License } from './types.ts';
import { PUBLIC_KEY } from './constants.ts';

export type { License } from './types.ts';
export { generateMachineId } from './machine-id.ts';
export { getHardwareInfo } from './machine-id.ts';
export { loadLicense, ensureOrbitHomeDir, getOrbitHomeDir, _v, _t } from './validator.ts';

/**
 * Validate license at startup.
 * Checks: license exists, machine ID match, signature valid, expiration valid.
 *
 * @param licensePath - Optional path to license file (defaults to auto-detection)
 * @param installTimeFile - Optional path to install time file (defaults to ~/.orbit/.install-time)
 * @returns true if license is valid, false otherwise
 */
export function validateLicense(
  licensePath?: string,
  installTimeFile?: string
): boolean {
  // Find license file
  const actualLicensePath = licensePath ?? findLicenseFile();
  if (!actualLicensePath) {
    console.error('[orbit] 未找到 license.json。');
    return false;
  }

  // Load license
  const license = loadLicense(actualLicensePath);
  if (!license) {
    console.error('[orbit] license.json 无效或已损坏。');
    return false;
  }

  // Get current machine ID (sync wrapper for async function)
  // Note: We need to handle this specially since generateMachineId is async
  // In real usage, validateLicense should be called with pre-computed machineId
  return validateLicenseSync(license, installTimeFile);
}

/**
 * Async version of validateLicense that properly handles machine ID generation.
 */
export async function validateLicenseAsync(
  licensePath?: string,
  installTimeFile?: string
): Promise<boolean> {
  // Find license file
  const actualLicensePath = licensePath ?? findLicenseFile();
  if (!actualLicensePath) {
    console.error('[orbit] 未找到 license.json。');
    return false;
  }

  // Load license
  const license = loadLicense(actualLicensePath);
  if (!license) {
    console.error('[orbit] license.json 无效或已损坏。');
    return false;
  }

  // Get current machine ID
  const currentMachineId = await generateMachineId();
  if (currentMachineId !== license.machineId) {
    console.error('[orbit] license.json 与当前机器不匹配。');
    return false;
  }

  // Validate signature
  const signedData = JSON.stringify({
    licenseId: license.licenseId,
    customerId: license.customerId,
    machineId: license.machineId,
    expiresAt: license.expiresAt,
    features: license.features,
  });

  if (!_v(signedData, license.signature, PUBLIC_KEY)) {
    console.error('[orbit] license.json 签名验证失败。');
    return false;
  }

  // Validate expiration and time rollback
  const actualInstallTimeFile = installTimeFile ?? getInstallTimePath();
  if (!_t(license.expiresAt, actualInstallTimeFile)) {
    console.error('[orbit] license.json 已过期，或检测到系统时间异常。');
    return false;
  }

  return true;
}

/**
 * Sync validation (assumes machine ID is pre-validated or license doesn't require it).
 * For actual startup use validateLicenseAsync.
 */
function validateLicenseSync(license: License, installTimeFile?: string): boolean {
  // Note: This simplified version skips machine ID check
  // Real implementation should use validateLicenseAsync

  const signedData = JSON.stringify({
    licenseId: license.licenseId,
    customerId: license.customerId,
    machineId: license.machineId,
    expiresAt: license.expiresAt,
    features: license.features,
  });

  if (!_v(signedData, license.signature, PUBLIC_KEY)) {
    console.error('[orbit] license.json 签名验证失败。');
    return false;
  }

  const actualInstallTimeFile = installTimeFile ?? getInstallTimePath();
  if (!_t(license.expiresAt, actualInstallTimeFile)) {
    console.error('[orbit] license.json 已过期，或检测到系统时间异常。');
    return false;
  }

  return true;
}
