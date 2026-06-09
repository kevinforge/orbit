/**
 * License data structure definitions
 */

export interface License {
  /** Unique license identifier */
  licenseId: string;
  /** Customer identifier */
  customerId: string;
  /** SHA256 hash of machine code */
  machineId: string;
  /** Expiration timestamp (ISO 8601) */
  expiresAt: string;
  /** Enabled feature modules */
  features: string[];
  /** RSA-SHA256 signature (base64) */
  signature: string;
}

export interface LicenseValidationResult {
  valid: boolean;
  error?: string;
}
