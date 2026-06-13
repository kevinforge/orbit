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

test("package has build script using Bun compile", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.engines?.node, ">=20");
  assert.ok(manifest.scripts?.build, "build script exists");
  assert.match(manifest.scripts?.build ?? "", /bun build/);
  assert.match(manifest.scripts?.build ?? "", /--compile/);
  assert.match(manifest.scripts?.build ?? "", /--bytecode/);
  assert.match(manifest.scripts?.build ?? "", /--minify/);
  assert.match(manifest.scripts?.build ?? "", /--sourcemap=none/);
});

test("default test script includes preset matching coverage", () => {
  const manifest = readPackageJson();

  assert.match(manifest.scripts?.test ?? "", /tests\/preset-match\.test\.ts/);
});
