import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type PackageJson = {
  bugs?: { url?: string };
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  repository?: { type?: string; url?: string };
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as PackageJson;
}

test("npm package publishes only the CLI launcher and built artifacts", () => {
  const manifest = readPackageJson();

  assert.deepEqual(manifest.files, ["bin/orbit.js", "dist/bin/orbit", "dist/bin/orbit.exe", "dist/ui/", "install.cjs"]);
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
  assert.equal(manifest.scripts?.["smoke:start"], "node scripts/smoke-start.mjs");
  assert.ok(fs.existsSync("scripts/smoke-start.mjs"));
});

test("package exposes open source metadata", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository?.type, "git");
  assert.equal(manifest.repository?.url, "git+https://github.com/QianzhenSun/orbit.git");
  assert.equal(manifest.bugs?.url, "https://github.com/QianzhenSun/orbit/issues");
  assert.equal(manifest.homepage, "https://github.com/QianzhenSun/orbit#readme");
  assert.ok(manifest.keywords?.includes("local-first"));
  assert.ok(manifest.keywords?.includes("agents"));
});

test("repository includes open source governance files", () => {
  assert.ok(fs.existsSync("LICENSE"));
  assert.ok(fs.existsSync("SECURITY.md"));
  assert.ok(fs.existsSync("CODE_OF_CONDUCT.md"));
  assert.ok(fs.existsSync("docs/DEPENDENCY_LICENSES.md"));
  assert.ok(fs.existsSync("docs/DATA_DIRECTORY.md"));
  assert.ok(fs.existsSync("CONTRIBUTING.md"));
  assert.ok(fs.existsSync("docs/RELEASE_CHECKLIST.md"));
  assert.ok(fs.existsSync("docs/RELEASE_NOTES_v1.0.0-rc.1.md"));
  assert.ok(fs.existsSync("docs/STABILITY_VERIFICATION.md"));
  assert.ok(fs.existsSync("docs/TERMINOLOGY_AND_ROUTING.md"));
});

test("dependency license identifiers stay within the reviewed open source set", () => {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as {
    packages?: Record<string, { license?: string }>;
  };
  const reviewed = new Set(["0BSD", "Apache-2.0", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0"]);
  const licenses = new Set(
    Object.values(lock.packages ?? {})
      .map((pkg) => pkg.license)
      .filter((license): license is string => Boolean(license)),
  );

  assert.deepEqual([...licenses].sort(), [...reviewed].sort());
});
