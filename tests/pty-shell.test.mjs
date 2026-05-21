import assert from "node:assert/strict";
import os from "node:os";
import pty from "node-pty";

function waitForOutput(term, matcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for ${matcher}. Output:\n${buffer}`));
    }, timeoutMs);

    const disposable = term.onData((chunk) => {
      buffer += chunk;
      if (matcher.test(buffer)) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(buffer);
      }
    });
  });
}

function waitForExit(term, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error("Timed out waiting for PTY process to exit"));
    }, timeoutMs);

    const disposable = term.onExit((event) => {
      clearTimeout(timer);
      disposable.dispose();
      resolve(event);
    });
  });
}

async function main() {
  const isWindows = os.platform() === "win32";
  const shell = isWindows ? "cmd.exe" : "bash";
  const args = isWindows ? ["/d"] : ["--noprofile", "--norc"];
  const command = isWindows
    ? "echo ORBIT_PTY_OK\r\nexit\r\n"
    : "printf 'ORBIT_PTY_OK\\n'; exit\n";

  const term = pty.spawn(shell, args, {
    name: "xterm-color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });

  let exited = false;
  const exitPromise = waitForExit(term).then((event) => {
    exited = true;
    return event;
  });

  try {
    const outputPromise = waitForOutput(term, /ORBIT_PTY_OK/);
    term.write(command);
    const output = await outputPromise;
    assert.match(output, /ORBIT_PTY_OK/);
    const exit = await exitPromise;
    assert.equal(exit.exitCode, 0);
  } finally {
    if (!exited) {
      term.kill();
    }
  }

  console.log("PTY shell accepts input and returns command output");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
