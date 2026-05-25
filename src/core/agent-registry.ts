import type { AgentId, AgentProfile, AgentState } from "../shared/types.ts";
import { AgentSession } from "./agent-session.ts";
import { EventBus } from "./event-bus.ts";

export class AgentRegistry {
  private readonly sessions = new Map<AgentId, AgentSession>();

  constructor(private readonly profiles: readonly AgentProfile[], eventBus: EventBus) {
    for (const profile of profiles) {
      this.sessions.set(profile.id, new AgentSession({ id: profile.id, label: profile.name, cwd: profile.cwd, eventBus }));
    }
  }

  startAll(): void {
    for (const session of this.sessions.values()) {
      session.start();
    }
  }

  get(agentId: AgentId): AgentSession {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return session;
  }

  ids(): AgentId[] {
    return this.profiles.map((profile) => profile.id);
  }

  states(): AgentState[] {
    return this.profiles.map((profile, index) => ({
      id: profile.id,
      label: profile.name,
      status: this.get(profile.id).getStatus(),
      selected: index === 0,
    }));
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
  }
}
