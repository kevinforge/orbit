import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getOrbitVersion, isVersionRequest } from '../src/cli-flags.ts';
import orbitPackageJson from '../package.json';

describe('standalone CLI flags', () => {
  describe('isVersionRequest', () => {
    it('detects --version', () => {
      assert.equal(isVersionRequest(['orbit', '--version']), true);
    });

    it('detects -v', () => {
      assert.equal(isVersionRequest(['orbit', '-v']), true);
    });

    it('detects the flag among other arguments', () => {
      assert.equal(isVersionRequest(['orbit', '--unknown', '--version', 'extra']), true);
    });

    it('ignores argument lists without a version request', () => {
      assert.equal(isVersionRequest(['orbit']), false);
      assert.equal(isVersionRequest(['orbit', '--help', '-h']), false);
      assert.equal(isVersionRequest(['orbit', '--machine-id']), false);
      assert.equal(isVersionRequest(['orbit', '--hardware-info']), false);
    });

    it('matches flags exactly instead of by prefix', () => {
      assert.equal(isVersionRequest(['orbit', '--version-lock']), false);
      assert.equal(isVersionRequest(['orbit', '-verbose']), false);
    });
  });

  describe('getOrbitVersion', () => {
    it('returns the version declared in package.json', () => {
      assert.equal(getOrbitVersion(), orbitPackageJson.version);
      assert.ok(getOrbitVersion().length > 0);
    });
  });
});
