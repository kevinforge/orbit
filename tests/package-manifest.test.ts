import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type PackageJson = {
  files?: string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as PackageJson;
}

test("npm package publishes only the CLI launcher and built artifacts", () => {
  const manifest = readPackageJson();

  assert.deepEqual(manifest.files, ["bin/", "dist/"]);
});

test("npm package has release safety checks", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.engines?.node, ">=20");
  assert.equal(manifest.scripts?.["pack:check"], "node scripts/check-package.mjs");
  assert.match(manifest.scripts?.prepublishOnly ?? "", /npm run test/);
  assert.match(manifest.scripts?.prepublishOnly ?? "", /npm run build/);
  assert.match(manifest.scripts?.prepublishOnly ?? "", /npm run pack:check/);
});
