import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import {
  License,
  generateMachineId,
  loadLicense,
  _v,
  _t,
} from '../src/license/index.ts';

// Generate test RSA key pair
let testPrivateKey: string;
let testPublicKey: string;

function setupTestKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testPublicKey = publicKey;
  testPrivateKey = privateKey;
}

function createTestLicense(machineId: string, expiresAt: string, features: string[] = ['core']): License & { signedData: string } {
  const licenseData = {
    licenseId: 'test-license-001',
    customerId: 'test-customer',
    machineId,
    expiresAt,
    features,
  };

  const sign = createSign('RSA-SHA256');
  sign.update(JSON.stringify(licenseData));
  sign.end();
  const signature = sign.sign(testPrivateKey, 'base64');

  return {
    ...licenseData,
    signature,
    signedData: JSON.stringify(licenseData),
  };
}

describe('License Module', () => {
  const testDir = path.join(os.tmpdir(), 'orbit-license-test-' + Date.now());
  const licenseFile = path.join(testDir, 'license.json');
  const installTimeFile = path.join(testDir, '.install-time');

  beforeEach(() => {
    setupTestKeys();
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('generateMachineId', () => {
    it('should return a SHA256 hash string', async () => {
      const machineId = await generateMachineId();
      assert.ok(machineId, 'machineId should exist');
      assert.strictEqual(machineId.length, 64, 'SHA256 hex digest should be 64 chars');
      assert.ok(/^[a-f0-9]+$/.test(machineId), 'Should be lowercase hex');
    });

    it('should return consistent machine ID on same machine', async () => {
      const id1 = await generateMachineId();
      const id2 = await generateMachineId();
      assert.strictEqual(id1, id2, 'Machine ID should be consistent');
    });
  });

  describe('loadLicense', () => {
    it('should return null if license file does not exist', () => {
      const license = loadLicense('/nonexistent/path/license.json');
      assert.strictEqual(license, null);
    });

    it('should parse valid license JSON', () => {
      const testLicense = createTestLicense(
        'abc123',
        '2025-12-31T23:59:59Z'
      );
      fs.writeFileSync(licenseFile, JSON.stringify(testLicense));

      const loaded = loadLicense(licenseFile);
      assert.ok(loaded, 'License should be loaded');
      assert.strictEqual(loaded!.licenseId, testLicense.licenseId);
      assert.strictEqual(loaded!.customerId, testLicense.customerId);
      assert.strictEqual(loaded!.machineId, testLicense.machineId);
    });

    it('should return null for invalid JSON', () => {
      fs.writeFileSync(licenseFile, 'not valid json');
      const loaded = loadLicense(licenseFile);
      assert.strictEqual(loaded, null);
    });

    it('should return null for license missing required fields', () => {
      fs.writeFileSync(licenseFile, JSON.stringify({ licenseId: 'test' }));
      const loaded = loadLicense(licenseFile);
      assert.strictEqual(loaded, null);
    });
  });

  describe('_v (signature validation)', () => {
    it('should verify valid RSA signature', () => {
      const testData = 'some data to sign';
      const sign = createSign('RSA-SHA256');
      sign.update(testData);
      sign.end();
      const signature = sign.sign(testPrivateKey, 'base64');

      const result = _v(testData, signature, testPublicKey);
      assert.strictEqual(result, true, 'Valid signature should pass');
    });

    it('should reject invalid signature', () => {
      const testData = 'some data';
      const fakeSignature = 'invalid-base64-signature!!!';

      const result = _v(testData, fakeSignature, testPublicKey);
      assert.strictEqual(result, false, 'Invalid signature should fail');
    });

    it('should reject tampered data', () => {
      const originalData = 'original content';
      const sign = createSign('RSA-SHA256');
      sign.update(originalData);
      sign.end();
      const signature = sign.sign(testPrivateKey, 'base64');

      const tamperedData = 'tampered content';
      const result = _v(tamperedData, signature, testPublicKey);
      assert.strictEqual(result, false, 'Tampered data should fail verification');
    });

    it('should reject signature with wrong public key', () => {
      const testData = 'some data';
      const sign = createSign('RSA-SHA256');
      sign.update(testData);
      sign.end();
      const signature = sign.sign(testPrivateKey, 'base64');

      // Generate a different key pair
      const { publicKey: wrongKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });

      const result = _v(testData, signature, wrongKey);
      assert.strictEqual(result, false, 'Wrong public key should fail');
    });
  });

  describe('_t (time validation)', () => {
    it('should return true for future expiration', () => {
      const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const result = _t(futureDate, installTimeFile);
      assert.strictEqual(result, true, 'Future expiration should pass');
    });

    it('should return false for past expiration', () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = _t(pastDate, installTimeFile);
      assert.strictEqual(result, false, 'Past expiration should fail');
    });

    it('should detect time rollback', () => {
      // Write a "future" timestamp (simulating previous run)
      const futureTime = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days in future
      fs.writeFileSync(installTimeFile, futureTime.toString());

      // Current time is "before" first install → rollback detected
      const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const result = _t(futureDate, installTimeFile);
      assert.strictEqual(result, false, 'Time rollback should be detected');
    });

    it('should create install-time file if not exists', () => {
      const newInstallFile = path.join(testDir, 'new-install-time');
      const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

      const result = _t(futureDate, newInstallFile);
      assert.strictEqual(result, true, 'Should pass and create file');
      assert.ok(fs.existsSync(newInstallFile), 'Install time file should be created');
    });

    it('should return false for invalid date format', () => {
      const result = _t('not-a-date', installTimeFile);
      assert.strictEqual(result, false, 'Invalid date should fail');
    });
  });
});
