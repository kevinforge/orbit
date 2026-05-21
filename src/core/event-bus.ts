import type { RuntimeEvent } from "../shared/types.ts";

export type EventHandler<TEvent = RuntimeEvent> = (event: TEvent) => void;
export type Unsubscribe = () => void;

export class EventBus<TEvent = RuntimeEvent> {
  private handlers = new Set<EventHandler<TEvent>>();

  subscribe(handler: EventHandler<TEvent>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  publish(event: TEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
