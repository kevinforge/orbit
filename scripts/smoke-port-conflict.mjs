#!/usr/bin/env node
/**
 * Occupy a local port, start the built Orbit binary with ORBIT_PORT set to that
 * port, and verify Orbit exits with a clear recovery hint.
 *
 * Usage:
 *   node scripts/smoke-port-conflict.mjs
 *   node scripts/smoke-port-conflict.mjs --binary ./dist/bin/orbit.exe
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 60000;

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

async function occupyPort() {
  const primary = net.createServer();
  await listen(primary, { port: 0, host: "0.0.0.0" });
  const address = primary.address();
  if (!address || typeof address === "string") {
    primary.close();
    throw new Error("Unable to allocate a local port");
  }
  const port = address.port;
  const servers = [primary];

  if (process.platform === "win32") {
    return { servers, port };
  }

  try {
    const ipv6 = net.createServer();
    await listen(ipv6, { port, host: "::", ipv6Only: false });
    servers.push(ipv6);
  } catch (error) {
    console.warn(
      `[orbit smoke] IPv6 wildcard occupancy was unavailable for port ${port}: ${formatError(error)}`,
    );
  }

  return { servers, port };
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServers(servers) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
}

async function runOrbitExpectingPortConflict(options, port) {
  const output = [];
  const smokeHome = createSmokeHome();
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
    const result = await Promise.race([
      onceExit(child).then(({ code, signal }) => ({ code, signal, timedOut: false })),
      sleep(options.timeoutMs).then(() => ({ code: null, signal: null, timedOut: true })),
    ]);

    if (result.timedOut) {
      await stopProcess(child);
    }

    const combinedOutput = output.join("");
    return { ...result, output: combinedOutput };
  } finally {
    await stopProcess(child);
    cleanupSmokeHome(smokeHome);
  }
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
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { servers, port } = await occupyPort();

  try {
    const result = await runOrbitExpectingPortConflict(options, port);
    const output = result.output.trim();

    if (result.timedOut) {
      throw new Error(`Orbit did not exit within ${options.timeoutMs}ms when port ${port} was occupied.`);
    }
    if (result.code === 0) {
      throw new Error(`Orbit exited successfully even though port ${port} was occupied.`);
    }
    if (result.code === null && result.signal) {
      throw new Error(`Orbit exited from signal ${result.signal} before reporting port ${port}. Output: ${output}`);
    }
    if (!output.includes(String(port))) {
      throw new Error(`Port conflict output did not mention occupied port ${port}. Exit code: ${result.code}. Output: ${output}`);
    }
    if (!output.includes("ORBIT_PORT")) {
      throw new Error(`Port conflict output did not mention ORBIT_PORT recovery. Exit code: ${result.code}. Output: ${output}`);
    }

    console.log(`[orbit smoke] occupied port ${port} produced a clear startup failure`);
  } finally {
    await closeServers(servers);
  }
}

main().catch((error) => {
  console.error(`[orbit smoke] ${formatError(error)}`);
  process.exit(1);
});
