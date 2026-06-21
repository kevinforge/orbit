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

  assert.deepEqual(manifest.files, ["bin/", "dist/", "install.cjs"]);
});

test("package build delegates to the protected standalone builder", () => {
  const manifest = readPackageJson();
  const standaloneBuilder = fs.readFileSync("scripts/build-standalone.mjs", "utf8");

  assert.equal(manifest.engines?.node, ">=20");
  assert.match(manifest.scripts?.build ?? "", /node scripts\/build-standalone\.mjs/);
  assert.match(standaloneBuilder, /"--compile"/);
  assert.match(standaloneBuilder, /"--bytecode"/);
  assert.match(standaloneBuilder, /"--minify"/);
  assert.match(standaloneBuilder, /"--sourcemap=none"/);
});

test("default test script uses complete cross-platform discovery", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.scripts?.test, "node scripts/run-tests.mjs");
  assert.equal(manifest.scripts?.["test:glob"], "npm run test");
});
