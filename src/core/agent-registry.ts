import type { AgentId, AgentState } from "../shared/types.ts";
import { AgentSession } from "./agent-session.ts";
import { EventBus } from "./event-bus.ts";

export class AgentRegistry {
  private readonly sessions: Record<AgentId, AgentSession>;

  constructor(cwd: string, eventBus: EventBus) {
    this.sessions = {
      agent1: new AgentSession({ id: "agent1", label: "Agent 1", cwd, eventBus }),
      agent2: new AgentSession({ id: "agent2", label: "Agent 2", cwd, eventBus }),
    };
  }

  startAll(): void {
    this.sessions.agent1.start();
    this.sessions.agent2.start();
  }

  get(agentId: AgentId): AgentSession {
    return this.sessions[agentId];
  }

  completeFromHook(agentId: AgentId, lastAssistantMessage: string): boolean {
    return this.sessions[agentId].completeFromHook(lastAssistantMessage);
  }

  states(): AgentState[] {
    return [
      {
        id: "agent1",
        label: "Agent 1",
        status: this.sessions.agent1.getStatus(),
        selected: true,
      },
      {
        id: "agent2",
        label: "Agent 2",
        status: this.sessions.agent2.getStatus(),
        selected: false,
      },
    ];
  }

  stopAll(): void {
    this.sessions.agent1.stop();
    this.sessions.agent2.stop();
  }
}
