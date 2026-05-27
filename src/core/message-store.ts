import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, MessageRouteState, NewChatMessage } from "../shared/types.ts";

type PersistedData = { messages: ChatMessage[]; nextId: number };

export class MessageStore {
  private messages: ChatMessage[] = [];
  private nextId = 1;
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.load();
    }
  }

  append(message: NewChatMessage): ChatMessage {
    const stored: ChatMessage = {
      ...message,
      id: this.createId(),
      createdAt: new Date().toISOString(),
    };

    this.messages.push(stored);
    this.save();
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
    this.save();
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
    this.save();
    return updated;
  }

  private createId(): string {
    const id = `msg_${String(this.nextId).padStart(6, "0")}`;
    this.nextId += 1;
    return id;
  }

  private load(): void {
    try {
      const data = fs.readFileSync(this.filePath!, "utf8");
      const parsed = JSON.parse(data) as PersistedData;
      this.messages = parsed.messages ?? [];
      this.nextId = parsed.nextId ?? this.messages.length + 1;
    } catch {
      this.messages = [];
      this.nextId = 1;
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const data: PersistedData = { messages: this.messages, nextId: this.nextId };
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.filePath);
  }
}
