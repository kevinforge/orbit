#!/usr/bin/env node
/**
 * License Generator for Orbit
 *
 * Usage:
 *   node scripts/generate-license.mjs --customer CUS-001 --machine <machine-id> --expires 2025-12-31 --features core
 *
 * Prerequisites:
 *   - private.pem file in the same directory or specify --key path/to/private.pem
 */

import { createSign, randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LicenseConfig {
  customerId: string;
  machineId: string;
  expiresAt: string;
  features: string[];
  privateKeyPath?: string;
  output?: string;
}

function parseArgs(): LicenseConfig {
  const args = process.argv.slice(2);
  const config: Partial<LicenseConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--customer=')) {
      config.customerId = arg.split('=')[1];
    } else if (arg === '--customer' && args[i + 1]) {
      config.customerId = args[++i];
    } else if (arg.startsWith('--machine=')) {
      config.machineId = arg.split('=')[1];
    } else if (arg === '--machine' && args[i + 1]) {
      config.machineId = args[++i];
    } else if (arg.startsWith('--expires=')) {
      config.expiresAt = arg.split('=')[1];
    } else if (arg === '--expires' && args[i + 1]) {
      config.expiresAt = args[++i];
    } else if (arg.startsWith('--features=')) {
      config.features = arg.split('=')[1].split(',');
    } else if (arg === '--features' && args[i + 1]) {
      config.features = args[++i].split(',');
    } else if (arg.startsWith('--key=')) {
      config.privateKeyPath = arg.split('=')[1];
    } else if (arg === '--key' && args[i + 1]) {
      config.privateKeyPath = args[++i];
    } else if (arg.startsWith('--output=')) {
      config.output = arg.split('=')[1];
    } else if (arg === '--output' && args[i + 1]) {
      config.output = args[++i];
    }
  }

  // Validate required fields
  if (!config.customerId) {
    console.error('Error: --customer is required');
    process.exit(1);
  }
  if (!config.machineId) {
    console.error('Error: --machine is required');
    process.exit(1);
  }
  if (!config.expiresAt) {
    console.error('Error: --expires is required');
    process.exit(1);
  }
  if (!config.features || config.features.length === 0) {
    config.features = ['core'];
  }

  // Parse and validate expiration date
  const expiresDate = new Date(config.expiresAt);
  if (isNaN(expiresDate.getTime())) {
    console.error('Error: Invalid expiration date format. Use YYYY-MM-DD or ISO format.');
    process.exit(1);
  }
  config.expiresAt = expiresDate.toISOString();

  return config as LicenseConfig;
}

function generateLicenseId(): string {
  const segment = () => randomBytes(4).toString('hex').toUpperCase();
  return `LIC-${segment()}-${segment()}`;
}

function loadPrivateKey(path: string): string {
  if (!existsSync(path)) {
    console.error(`Error: Private key not found at ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf8');
}

function signLicense(licenseData: object, privateKey: string): string {
  const sign = createSign('RSA-SHA256');
  sign.update(JSON.stringify(licenseData));
  sign.end();
  return sign.sign(privateKey, 'base64');
}

function main() {
  console.log('🔐 Orbit License Generator\n');

  const config = parseArgs();

  // Find private key
  const keyPath = config.privateKeyPath || join(__dirname, 'private.pem');
  console.log(`Looking for private key: ${keyPath}`);

  if (!existsSync(keyPath)) {
    console.error('\n❌ Private key not found!');
    console.error('\nTo generate a key pair:');
    console.error('  openssl genrsa -out private.pem 2048');
    console.error('  openssl rsa -in private.pem -pubout -out public.pem');
    console.error('\nKeep private.pem secure and never commit it to the repository.');
    process.exit(1);
  }

  const privateKey = loadPrivateKey(keyPath);

  // Generate license
  const licenseId = generateLicenseId();
  const licenseData = {
    licenseId,
    customerId: config.customerId,
    machineId: config.machineId,
    expiresAt: config.expiresAt,
    features: config.features,
  };

  const signature = signLicense(licenseData, privateKey);

  const license = {
    ...licenseData,
    signature,
  };

  // Output
  const outputPath = config.output || 'license.json';
  writeFileSync(outputPath, JSON.stringify(license, null, 2));

  console.log('\n✅ License generated successfully!\n');
  console.log('License Details:');
  console.log(`  License ID: ${licenseId}`);
  console.log(`  Customer:   ${config.customerId}`);
  console.log(`  Machine ID: ${config.machineId.slice(0, 16)}...`);
  console.log(`  Expires:    ${new Date(config.expiresAt).toLocaleDateString()}`);
  console.log(`  Features:   ${config.features.join(', ')}`);
  console.log(`\n📄 Output: ${outputPath}`);
}

main();