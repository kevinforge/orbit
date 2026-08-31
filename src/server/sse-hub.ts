import type { ServerResponse } from "node:http";

import type { RuntimeEvent } from "../shared/types.ts";

export class SseHub {
  private readonly clients = new Map<ServerResponse, { workspaceId?: string; conversationId?: string }>();
  private nextSequence = 0;
  private readonly history: Array<{ sequence: number; event: RuntimeEvent }> = [];
  private readonly maxHistory = 500;

  add(res: ServerResponse, scope: { workspaceId?: string; conversationId?: string } = {}, lastEventId?: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    this.clients.set(res, scope);
    if (lastEventId !== undefined) {
      const oldest = this.history[0]?.sequence;
      const historyGap = lastEventId > this.nextSequence
        || (oldest === undefined ? lastEventId > 0 : lastEventId < oldest - 1);
      if (historyGap) {
        // Give the gap marker the current cursor so EventSource will resume
        // from this point after the client refreshes its snapshot.
        this.write(res, { type: "events.gap", ...scope }, this.nextSequence);
      } else {
        for (const entry of this.history) {
          if (entry.sequence > lastEventId && this.matches(entry.event, scope)) {
            this.write(res, entry.event, entry.sequence);
          }
        }
      }
    }
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  publish(event: RuntimeEvent): void {
    const sequence = ++this.nextSequence;
    this.history.push({ sequence, event });
    if (this.history.length > this.maxHistory) this.history.shift();

    for (const [client, scope] of this.clients) {
      if (this.matches(event, scope)) this.write(client, event, sequence);
    }
  }

  private matches(event: RuntimeEvent, scope: { workspaceId?: string; conversationId?: string }): boolean {
    if (event.type === "runtime.availability.updated" || event.type === "running.updated") return true;
    if (scope.workspaceId && "workspaceId" in event && event.workspaceId !== undefined && event.workspaceId !== scope.workspaceId) return false;
    if (scope.conversationId && "conversationId" in event && event.conversationId !== undefined && event.conversationId !== scope.conversationId) return false;
    return true;
  }

  private write(res: ServerResponse, event: RuntimeEvent, sequence?: number): void {
    res.write(`${sequence === undefined ? "" : `id: ${sequence}\n`}data: ${JSON.stringify(event)}\n\n`);
  }

  closeAll(): void {
    for (const client of this.clients.keys()) {
      client.end();
    }
    this.clients.clear();
  }
}
