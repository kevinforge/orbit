#!/usr/bin/env node
/**
 * Key Generator for Orbit License System
 *
 * This script:
 * 1. Generates RSA key pair (2048-bit)
 * 2. Updates PUBLIC_KEY in src/license/constants.ts
 * 3. Prints backup reminders for private key
 *
 * Usage:
 *   node scripts/generate-keys.mjs
 *
 * IMPORTANT:
 *   - Private key is NEVER committed to the repository
 *   - Backup private key to multiple secure locations immediately
 *   - Use an offline machine for maximum security
 */

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const CONSTANTS_PATH = join(root, 'src', 'license', 'constants.ts');
const PRIVATE_KEY_PATH = join(root, 'private.pem');

function generateKeys() {
  console.log('\n🔐 Orbit License Key Generator\n');
  console.log('━'.repeat(50));

  // Generate RSA key pair
  console.log('\n[1/3] Generating RSA 2048-bit key pair...\n');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Save private key (DO NOT COMMIT)
  writeFileSync(PRIVATE_KEY_PATH, privateKey);
  console.log('   ✅ Private key saved to: private.pem');
  console.log('   ⚠️  This file is excluded from git (see .gitignore)');

  // Update PUBLIC_KEY in constants.ts
  console.log('\n[2/3] Updating PUBLIC_KEY in src/license/constants.ts...\n');

  let constantsContent = readFileSync(CONSTANTS_PATH, 'utf8');

  // Find and replace PUBLIC_KEY
  const publicKeyPattern = /export const PUBLIC_KEY = `-----BEGIN RSA PUBLIC KEY-----[\s\S]*?-----END RSA PUBLIC KEY-----`;/;

  if (publicKeyPattern.test(constantsContent)) {
    constantsContent = constantsContent.replace(publicKeyPattern, `export const PUBLIC_KEY = \`${publicKey}\`;`);
    writeFileSync(CONSTANTS_PATH, constantsContent);
    console.log('   ✅ PUBLIC_KEY updated in constants.ts');
  } else {
    console.log('   ❌ Could not find PUBLIC_KEY pattern in constants.ts');
    console.log('   Please manually update the file.');
  }

  // Backup reminders
  console.log('\n[3/3] Private Key Security Reminders\n');
  console.log('━'.repeat(50));
  console.log('\n   🔴 CRITICAL: Your private key is the key to all license generation.\n');
  console.log('   If lost, you must regenerate keys and republish Orbit.\n');
  console.log('   All existing licenses will become invalid.\n\n');

  console.log('   📋 Backup Checklist:\n');
  console.log('   [ ] Copy private.pem to an encrypted USB drive');
  console.log('   [ ] Store a copy in a secure cloud vault (1Password, etc.)');
  console.log('   [ ] Print a copy and store in a physical safe');
  console.log('   [ ] Share with trusted team member (split custody)');
  console.log('   [ ] Delete private.pem from this machine after backup\n');

  console.log('━'.repeat(50));
  console.log('\n   ⚡ Next Steps:\n');
  console.log('   1. Complete ALL backup steps above');
  console.log('   2. Run: npm run build');
  console.log('   3. Test with: node scripts/generate-license.mjs --customer test --machine test --expires 2025-12-31\n');

  console.log('━'.repeat(50));
  console.log('\n✅ Key generation complete!\n');
}

// Check if keys already exist
if (existsSync(PRIVATE_KEY_PATH)) {
  console.log('\n⚠️  Warning: private.pem already exists.\n');
  console.log('   Generating new keys will invalidate all existing licenses.\n');
  console.log('   Continue? (y/N): ');

  // In non-interactive mode, require --force flag
  if (!process.argv.includes('--force')) {
    console.log('   Run with --force to overwrite existing keys.\n');
    process.exit(1);
  }
}

generateKeys();