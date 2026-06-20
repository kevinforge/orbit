import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDirectory = join(repositoryRoot, "tests");
const testFiles = readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => relative(repositoryRoot, join(testsDirectory, entry.name)))
  .sort();

if (testFiles.length === 0) {
  throw new Error("No test files found in tests/*.test.ts");
}

const result = spawnSync(process.execPath, ["--test", "--import", "tsx", ...testFiles], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
