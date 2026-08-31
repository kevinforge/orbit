import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { SseHub } from "../src/server/sse-hub.ts";

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];

  writeHead(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {}
}

function response(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
}

function events(res: FakeResponse): Array<{ id?: number; data: Record<string, unknown> }> {
  return res.chunks
    .join("")
    .split("\n\n")
    .filter((chunk) => chunk.includes("data: "))
    .map((chunk) => {
      const id = chunk.match(/^id: (\d+)$/m)?.[1];
      const data = chunk.match(/^data: (.+)$/m)?.[1];
      return { ...(id ? { id: Number(id) } : {}), data: JSON.parse(data!) as Record<string, unknown> };
    });
}

test("SSE only sends conversation events to the matching workspace and conversation", () => {
  const hub = new SseHub();
  const page = response();
  hub.add(page, { workspaceId: "ws-a", conversationId: "conv-1" });

  hub.publish({ type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: "a", kind: "system", content: "a", createdAt: "now" } });
  hub.publish({ type: "message.created", workspaceId: "ws-b", conversationId: "conv-1", message: { id: "b", kind: "system", content: "b", createdAt: "now" } });
  hub.publish({ type: "message.created", workspaceId: "ws-a", conversationId: "conv-2", message: { id: "c", kind: "system", content: "c", createdAt: "now" } });

  assert.deepEqual(events(page).map((entry) => entry.data), [
    { type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: "a", kind: "system", content: "a", createdAt: "now" } },
  ]);
});

test("SSE replays events after the page's last event id", () => {
  const hub = new SseHub();
  const initial = response();
  hub.add(initial, { workspaceId: "ws-a", conversationId: "conv-1" });
  hub.publish({ type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: "a", kind: "system", content: "a", createdAt: "now" } });
  hub.publish({ type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: "b", kind: "system", content: "b", createdAt: "now" } });

  const resumed = response();
  hub.add(resumed, { workspaceId: "ws-a", conversationId: "conv-1" }, 1);
  assert.deepEqual(events(resumed).map((entry) => entry.data), [
    { type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: "b", kind: "system", content: "b", createdAt: "now" } },
  ]);
});

test("SSE emits a gap marker when the requested cursor is no longer retained", () => {
  const hub = new SseHub();
  const publisher = response();
  hub.add(publisher);
  for (let i = 0; i < 502; i += 1) {
    hub.publish({ type: "message.created", workspaceId: "ws-a", conversationId: "conv-1", message: { id: String(i), kind: "system", content: String(i), createdAt: "now" } });
  }

  const resumed = response();
  hub.add(resumed, { workspaceId: "ws-a", conversationId: "conv-1" }, 1);
  const replay = events(resumed);
  assert.equal(replay.length, 1);
  assert.equal(replay[0]?.data.type, "events.gap");
  assert.ok(replay[0]?.id);
});
