/**
 * License validation module.
 * Implements RSA signature verification and time-based checks.
 */

import { createVerify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type { License } from './types.ts';
import { PUBLIC_KEY, LICENSE_PATHS, INSTALL_TIME_FILE } from './constants.ts';

/**
 * Verify RSA-SHA256 signature.
 * @param data - Original data that was signed
 * @param signature - Base64 encoded signature
 * @param publicKey - RSA public key in PEM format
 * @returns true if signature is valid
 */
export function _v(data: string, signature: string, publicKey: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(data);
    verifier.end();
    return verifier.verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * Validate expiration time and detect time rollback.
 * @param expiresAt - ISO 8601 expiration timestamp
 * @param installTimeFile - Path to install time tracking file
 * @returns true if time is valid and not rolled back
 */
export function _t(expiresAt: string, installTimeFile: string): boolean {
  const now = Date.now();

  // Check expiration
  const expirationTime = new Date(expiresAt).getTime();
  if (isNaN(expirationTime)) {
    return false;
  }
  if (now >= expirationTime) {
    return false;
  }

  // Time rollback detection
  const installDir = dirname(installTimeFile);
  if (!existsSync(installDir)) {
    try {
      mkdirSync(installDir, { recursive: true });
    } catch {
      // Directory already exists or cannot create
    }
  }

  if (existsSync(installTimeFile)) {
    try {
      const firstRun = parseInt(readFileSync(installTimeFile, 'utf8').trim(), 10);
      if (!isNaN(firstRun) && now < firstRun) {
        // System time is earlier than first run - rollback detected
        return false;
      }
    } catch {
      // Corrupted file, continue
    }
  } else {
    // First run - record current time
    try {
      writeFileSync(installTimeFile, now.toString(), 'utf8');
    } catch {
      // Cannot write, ignore
    }
  }

  return true;
}

/**
 * Load license from file.
 * @param licensePath - Path to license.json file
 * @returns License object or null if invalid/missing
 */
export function loadLicense(licensePath: string): License | null {
  try {
    if (!existsSync(licensePath)) {
      return null;
    }

    const content = readFileSync(licensePath, 'utf8');
    const license = JSON.parse(content) as License;

    // Validate required fields
    const requiredFields: (keyof License)[] = [
      'licenseId', 'customerId', 'machineId', 'expiresAt', 'features', 'signature'
    ];

    for (const field of requiredFields) {
      if (!(field in license) || license[field] === undefined) {
        return null;
      }
    }

    // Validate types
    if (typeof license.licenseId !== 'string' ||
        typeof license.customerId !== 'string' ||
        typeof license.machineId !== 'string' ||
        typeof license.expiresAt !== 'string' ||
        !Array.isArray(license.features) ||
        typeof license.signature !== 'string') {
      return null;
    }

    return license;
  } catch {
    return null;
  }
}

/**
 * Find license file in standard locations.
 * @returns Path to license file or null if not found
 */
export function findLicenseFile(): string | null {
  for (const basePath of LICENSE_PATHS) {
    const expandedPath = basePath.startsWith('~')
      ? basePath.replace('~', homedir())
      : basePath;
    if (existsSync(expandedPath)) {
      return expandedPath;
    }
  }
  return null;
}

/**
 * Get install time file path.
 * @returns Path to .install-time file
 */
export function getInstallTimePath(): string {
  return `${homedir()}/.orbit/${INSTALL_TIME_FILE}`;
}
