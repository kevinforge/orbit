import http from "node:http";
import https from "node:https";

const agentId = process.env.ORBIT_AGENT_ID;
const hookUrl = process.env.ORBIT_HOOK_URL;

if (!agentId || !hookUrl) {
  process.exit(0);
}

const input = await readStdin();
let hookInput;
try {
  hookInput = JSON.parse(input || "{}");
} catch {
  process.exit(0);
}

if (hookInput.hook_event_name !== "Stop") {
  process.exit(0);
}

const payload = JSON.stringify({
  agentId,
  sessionId: hookInput.session_id,
  transcriptPath: hookInput.transcript_path,
  lastAssistantMessage: hookInput.last_assistant_message ?? "",
});

await postJson(hookUrl, payload).catch(() => undefined);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function postJson(urlValue, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Orbit hook request timed out"));
    });
    req.end(body);
  });
}
