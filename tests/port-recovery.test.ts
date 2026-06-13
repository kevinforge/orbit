import assert from "node:assert/strict";
import test from "node:test";

import { findPortOwners, isOrbitPortOwner } from "../src/server/port-recovery.ts";

test("isOrbitPortOwner identifies Orbit commands", () => {
  assert.equal(isOrbitPortOwner({ pid: 1, command: "C:\\Users\\me\\AppData\\Roaming\\npm\\orbit.exe" }), true);
  assert.equal(isOrbitPortOwner({ pid: 2, command: "bun C:\\repo\\orbit\\src\\server\\index.ts" }), true);
  assert.equal(isOrbitPortOwner({ pid: 3, command: "C:\\Program Files\\Other\\server.exe" }), false);
  assert.equal(isOrbitPortOwner({ pid: 4 }), false);
});

test("findPortOwners parses Windows netstat listening owners", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const owners = await findPortOwners(4317, async (file, args) => {
      if (file === "netstat.exe") {
        assert.deepEqual(args, ["-ano", "-p", "tcp"]);
        return {
          stdout: [
            "  Proto  Local Address          Foreign Address        State           PID",
            "  TCP    0.0.0.0:4317           0.0.0.0:0              LISTENING       39216",
            "  TCP    [::]:4317              [::]:0                 LISTENING       39216",
            "  TCP    [::1]:4317             [::1]:50079            CLOSE_WAIT      39216",
            "  TCP    0.0.0.0:4318           0.0.0.0:0              LISTENING       11111",
          ].join("\n"),
        };
      }
      assert.equal(file, "powershell.exe");
      return { stdout: "C:\\Users\\me\\AppData\\Roaming\\npm\\orbit.exe\n" };
    });

    assert.deepEqual(owners, [{ pid: 39216, command: "C:\\Users\\me\\AppData\\Roaming\\npm\\orbit.exe" }]);
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
});
