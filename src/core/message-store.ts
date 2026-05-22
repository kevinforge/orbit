import type { ChatMessage, MessageRouteState, NewChatMessage } from "../shared/types.ts";

export class MessageStore {
  private messages: ChatMessage[] = [];
  private nextId = 1;

  append(message: NewChatMessage): ChatMessage {
    const stored: ChatMessage = {
      ...message,
      id: this.createId(),
      createdAt: new Date().toISOString(),
    };

    this.messages.push(stored);
    return stored;
  }

  add(message: NewChatMessage): ChatMessage {
    return this.append(message);
  }

  update(id: string, patch: Partial<Omit<ChatMessage, "id" | "createdAt">>): ChatMessage {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index === -1) {
      throw new Error(`Message not found: ${id}`);
    }

    const updated = { ...this.messages[index], ...patch };
    this.messages[index] = updated;
    return updated;
  }

  list(): ChatMessage[] {
    return [...this.messages];
  }

  get(id: string): ChatMessage | null {
    return this.messages.find((message) => message.id === id) ?? null;
  }

  markRouteState(id: string, routeState: MessageRouteState): ChatMessage | null {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index === -1) {
      return null;
    }

    const updated = { ...this.messages[index], routeState };
    this.messages[index] = updated;
    return updated;
  }

  private createId(): string {
    const id = `msg_${String(this.nextId).padStart(6, "0")}`;
    this.nextId += 1;
    return id;
  }
}
