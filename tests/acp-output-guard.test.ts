import assert from "node:assert/strict";
import test from "node:test";

import {
  AcpFrameLimitError,
  AcpStderrForwarder,
  BoundedTextTail,
  createAcpFrameLimitTransform,
} from "../src/core/acp-output-guard.ts";

test("ACP frame guard limits one NDJSON frame across chunks", async () => {
  const guard = createAcpFrameLimitTransform(5);
  const error = new Promise<Error>((resolve) => guard.once("error", resolve));

  guard.write("123");
  guard.write("456");

  assert.ok(await error instanceof AcpFrameLimitError);
});

test("ACP frame guard resets its counter at each newline", async () => {
  const guard = createAcpFrameLimitTransform(5);
  const output: Buffer[] = [];
  guard.on("data", (chunk: Buffer) => output.push(chunk));

  guard.end("12345\nabcde\n");
  await new Promise<void>((resolve, reject) => {
    guard.once("end", resolve);
    guard.once("error", reject);
  });

  assert.equal(Buffer.concat(output).toString("utf8"), "12345\nabcde\n");
});

test("bounded stderr text retains only the latest complete UTF-8 tail", () => {
  const tail = new BoundedTextTail(6);
  tail.append("old-");
  tail.append("你好");

  assert.equal(tail.text(), "你好");
});

test("AcpStderrForwarder resets truncation and tail across pool rebind", () => {
  const forwarder = new AcpStderrForwarder(10);

  const firstOutputs: string[] = [];
  for (const output of forwarder.forward("overflow!!!")) firstOutputs.push(output);
  assert.deepEqual(firstOutputs, ["overflow!!", "\n[ACP stderr output truncated]\n"]);
  assert.equal(forwarder.tailText(), "verflow!!!");

  // While truncated, further stderr is silently dropped (first lease exhausted budget).
  assert.deepEqual(forwarder.forward("dropped"), []);

  // rebind() resets state: the second lease forwards stderr and tails independently.
  forwarder.reset();
  assert.equal(forwarder.tailText(), "");

  const secondOutputs: string[] = [];
  for (const output of forwarder.forward("ok")) secondOutputs.push(output);
  assert.deepEqual(secondOutputs, ["ok"]);
  assert.ok(forwarder.tailText().includes("ok"));
});
