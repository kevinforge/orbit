import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hookPath = fileURLToPath(new URL("../scripts/claude-user-prompt-hook.mjs", import.meta.url));

test("UserPromptSubmit hook is quiet for ordinary prompts", async () => {
  const { stdout } = await runHook("agent1", {
    hook_event_name: "UserPromptSubmit",
    prompt: "你好",
  });

  assert.equal(stdout, "");
});

test("UserPromptSubmit hook emits additionalContext for agent collaboration prompts", async () => {
  const { stdout } = await runHook("agent1", {
    hook_event_name: "UserPromptSubmit",
    prompt: "让 agent2 帮我检查一下",
  });

  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /You are Agent 1 \(agent1\)/);
  assert.match(output.hookSpecificOutput.additionalContext, /@agent2/);
});

async function runHook(agentId: string, input: unknown): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        ORBIT_AGENT_ID: agentId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`Hook exited with code ${code}: ${stderr}`));
    });

    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
