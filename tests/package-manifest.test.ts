import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type PackageJson = {
  bugs?: { url?: string };
  files?: string[];
  homepage?: string;
  keywords?: string[];
  license?: string;
  name?: string;
  publishConfig?: { access?: string };
  repository?: { type?: string; url?: string };
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as PackageJson;
}

test("npm package publishes only the CLI launcher and built artifacts", () => {
  const manifest = readPackageJson();

  assert.deepEqual(manifest.files, ["bin/orbit.js", "dist/bin/", "dist/ui/", "install.cjs"]);
});

test("package build delegates to the protected standalone builder", () => {
  const manifest = readPackageJson();
  const standaloneBuilder = fs.readFileSync("scripts/build-standalone.mjs", "utf8");

  assert.equal(manifest.engines?.node, ">=20");
  assert.match(manifest.scripts?.build ?? "", /node scripts\/build-standalone\.mjs/);
  assert.match(manifest.scripts?.["build:all"] ?? "", /--all --package-layout/);
  assert.equal(manifest.scripts?.["package:npm"], "node scripts/assemble-npm-package.mjs");
  assert.equal(manifest.scripts?.prepublishOnly, "npm run test && npm run build");
  assert.match(standaloneBuilder, /"--compile"/);
  assert.match(standaloneBuilder, /"--bytecode"/);
  assert.match(standaloneBuilder, /"--minify"/);
  assert.match(standaloneBuilder, /"--sourcemap=none"/);
});

test("default test script uses complete cross-platform discovery", () => {
  const manifest = readPackageJson();
  const smokeStart = fs.readFileSync("scripts/smoke-start.mjs", "utf8");
  const smokePortConflict = fs.readFileSync("scripts/smoke-port-conflict.mjs", "utf8");
  const installer = fs.readFileSync("install.cjs", "utf8");

  assert.equal(manifest.scripts?.test, "node scripts/run-tests.mjs");
  assert.equal(manifest.scripts?.["test:glob"], "npm run test");
  assert.equal(manifest.scripts?.["smoke:start"], "node scripts/smoke-start.mjs");
  assert.equal(manifest.scripts?.["smoke:port-conflict"], "node scripts/smoke-port-conflict.mjs");
  assert.ok(fs.existsSync("scripts/smoke-start.mjs"));
  assert.ok(fs.existsSync("scripts/smoke-port-conflict.mjs"));

  for (const smokeScript of [smokeStart, smokePortConflict]) {
    assert.match(smokeScript, /mkdtempSync/);
    assert.match(smokeScript, /HOME: homeDir/);
    assert.match(smokeScript, /USERPROFILE: homeDir/);
    assert.match(smokeScript, /cleanupSmokeHome/);
  }

  assert.match(installer, /windows-x64/);
  assert.match(installer, /macos-arm64/);
  assert.match(installer, /path\.join\(__dirname, "dist", "bin", info\.asset, info\.source\)/);
});

test("package exposes open source metadata", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.name, "@kevinforge/orbit");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.repository?.type, "git");
  assert.equal(manifest.repository?.url, "git+https://github.com/kevinforge/orbit.git");
  assert.equal(manifest.bugs?.url, "https://github.com/kevinforge/orbit/issues");
  assert.equal(manifest.homepage, "https://github.com/kevinforge/orbit#readme");
  assert.ok(manifest.keywords?.includes("local-first"));
  assert.ok(manifest.keywords?.includes("agents"));
});

test("repository includes open source governance files", () => {
  assert.ok(fs.existsSync("LICENSE"));
  assert.ok(fs.existsSync("SECURITY.md"));
  assert.ok(fs.existsSync("SUPPORT.md"));
  assert.ok(fs.existsSync("CODE_OF_CONDUCT.md"));
  assert.ok(fs.existsSync(".github/ISSUE_TEMPLATE/bug_report.yml"));
  assert.ok(fs.existsSync(".github/ISSUE_TEMPLATE/config.yml"));
  assert.ok(fs.existsSync(".github/ISSUE_TEMPLATE/feature_request.yml"));
  assert.ok(fs.existsSync("docs/DEPENDENCY_LICENSES.md"));
  assert.ok(fs.existsSync("docs/DATA_DIRECTORY.md"));
  assert.ok(fs.existsSync("CONTRIBUTING.md"));
  assert.ok(fs.existsSync("docs/RELEASE_DECISIONS.md"));
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
