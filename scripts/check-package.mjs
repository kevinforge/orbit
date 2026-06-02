import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm_execpath is not set. Run this check through npm: npm run pack:check");
}

const raw = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const packages = JSON.parse(raw);
if (!Array.isArray(packages) || packages.length !== 1) {
  throw new Error("Expected npm pack --dry-run --json to return exactly one package.");
}

const packedFiles = packages[0]?.files;
if (!Array.isArray(packedFiles)) {
  throw new Error("npm pack output did not include a files list.");
}

const paths = packedFiles.map((file) => file.path).sort();
const pathSet = new Set(paths);

const requiredFiles = ["bin/orbit.js", "dist/server/index.js", "dist/ui/index.html"];
for (const requiredFile of requiredFiles) {
  if (!pathSet.has(requiredFile)) {
    throw new Error(`Packed package is missing required file: ${requiredFile}`);
  }
}

const forbiddenPrefixes = [
  ".claude/",
  ".github/",
  ".local/",
  ".orbit/",
  ".playwright-mcp/",
  "docs/",
  "scripts/",
  "src/",
  "tests/",
];

const forbiddenSuffixes = [".map", ".ts", ".tsx"];
const forbiddenNames = new Set([
  ".env",
  ".env.local",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "README.md",
  "README.zh-CN.md",
]);

const forbiddenFiles = paths.filter((filePath) => {
  return (
    forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix)) ||
    forbiddenSuffixes.some((suffix) => filePath.endsWith(suffix)) ||
    forbiddenNames.has(filePath) ||
    filePath.endsWith(".png")
  );
});

if (forbiddenFiles.length > 0) {
  throw new Error(`Packed package includes forbidden files:\n${forbiddenFiles.join("\n")}`);
}

console.log(`Package check passed with ${paths.length} files.`);
