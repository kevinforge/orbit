import type { ServerResponse } from "node:http";

import type { RuntimeEvent } from "../shared/types.ts";

export class SseHub {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  publish(event: RuntimeEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of this.clients) {
      client.write(payload);
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}
