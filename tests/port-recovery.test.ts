import assert from "node:assert/strict";
import test from "node:test";

import { findPortOwners, isOrbitPortOwner, localAddressMatchesPort } from "../src/server/port-recovery.ts";

test("isOrbitPortOwner identifies Orbit commands", () => {
  assert.equal(isOrbitPortOwner({ pid: 1, command: "C:\\Users\\me\\AppData\\Roaming\\npm\\orbit.exe" }), true);
  assert.equal(isOrbitPortOwner({ pid: 2, command: "\"C:\\Users\\me\\AppData\\Roaming\\npm\\orbit.exe\" --flag" }), true);
  assert.equal(isOrbitPortOwner({ pid: 3, command: "C:\\Program Files\\Other\\server.exe" }), false);
  assert.equal(isOrbitPortOwner({ pid: 4, command: "node scripts\\smoke-port-conflict.mjs --binary .\\dist\\bin\\orbit.exe" }), false);
  assert.equal(isOrbitPortOwner({ pid: 5, command: "bun C:\\repo\\orbit\\src\\server\\index.ts" }), false);
  assert.equal(isOrbitPortOwner({ pid: 6 }), false);
});

test("localAddressMatchesPort matches exact port suffix", () => {
  // Exact match
  assert.equal(localAddressMatchesPort("0.0.0.0:4317", 4317), true);
  assert.equal(localAddressMatchesPort("[::]:4317", 4317), true);
  assert.equal(localAddressMatchesPort("127.0.0.1:80", 80), true);

  // No false positives on higher ports
  assert.equal(localAddressMatchesPort("0.0.0.0:14317", 4317), false);
  assert.equal(localAddressMatchesPort("0.0.0.0:24317", 4317), false);
  assert.equal(localAddressMatchesPort("0.0.0.0:180", 80), false);
  assert.equal(localAddressMatchesPort("0.0.0.0:280", 80), false);
  assert.equal(localAddressMatchesPort("0.0.0.0:8080", 80), false);

  // Edge cases
  assert.equal(localAddressMatchesPort("0.0.0.0:4317", 4318), false);
  assert.equal(localAddressMatchesPort("no-colon", 4317), false);
  assert.equal(localAddressMatchesPort("::", 4317), false);
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
            "  TCP    0.0.0.0:14317          0.0.0.0:0              LISTENING       99999",
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
