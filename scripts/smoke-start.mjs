#!/usr/bin/env node
/**
 * Start the built Orbit binary, wait for /api/state, then stop it.
 *
 * Usage:
 *   node scripts/smoke-start.mjs
 *   node scripts/smoke-start.mjs --binary ./dist/bin/orbit.exe
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const options = {
    binary: defaultBinaryPath(),
    timeoutMs: Number(process.env.ORBIT_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--binary") {
      const value = argv[i + 1];
      if (!value) throw new Error("--binary requires a path");
      options.binary = path.resolve(root, value);
      i += 1;
    } else if (arg.startsWith("--binary=")) {
      options.binary = path.resolve(root, arg.slice("--binary=".length));
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      options.timeoutMs = value;
      i += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      const value = Number(arg.slice("--timeout-ms=".length));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-ms requires a positive number");
      options.timeoutMs = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function defaultBinaryPath() {
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(root, "dist", "bin", `orbit${ext}`);
}

function createSmokeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-smoke-home-"));
}

function smokeEnv(port, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ORBIT_PORT: String(port),
    ORBIT_RUNTIME_PROBE_INTERVAL_MS: "600000",
  };
}

function cleanupSmokeHome(homeDir) {
  fs.rmSync(homeDir, { recursive: true, force: true });
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a local port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForState(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const result = await requestState(port);
      if (result.statusCode === 200) return;
      lastError = `HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for /api/state on port ${port}. Last error: ${lastError}`);
}

async function requestState(port) {
  return await new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/state",
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill();
  const exited = await Promise.race([
    onceExit(child).then(() => true),
    sleep(3000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await onceExit(child);
  }
}

async function onceExit(child) {
  return await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = await findFreePort();
  const smokeHome = createSmokeHome();
  const output = [];

  const child = spawn(options.binary, [], {
    cwd: root,
    env: smokeEnv(port, smokeHome),
    windowsHide: true,
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  try {
    child.on("error", (error) => {
      output.push(String(error));
    });
    await waitForState(port, options.timeoutMs);
    console.log(`[orbit smoke] /api/state returned 200 on port ${port}`);
  } catch (error) {
    const details = output.join("").trim();
    if (details) {
      console.error("[orbit smoke] process output:");
      console.error(details);
    }
    throw error;
  } finally {
    await stopProcess(child);
    cleanupSmokeHome(smokeHome);
  }
}

main().catch((error) => {
  console.error(`[orbit smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
