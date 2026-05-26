import type { AgentId, AgentProfile, AgentState } from "../shared/types.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { claudeCodeRuntime } from "./claude-cli-runtime.ts";
import { codeBuddyRuntime } from "./codebuddy-cli-runtime.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionStore } from "./session-store.ts";

const DEFAULT_RUNTIMES = new Map<AgentRuntime["kind"], AgentRuntime>([
  [claudeCodeRuntime.kind, claudeCodeRuntime],
  [codeBuddyRuntime.kind, codeBuddyRuntime],
]);

export class AgentRegistry {
  private readonly sessions = new Map<AgentId, AgentSession>();

  constructor(
    private readonly profiles: readonly AgentProfile[],
    eventBus: EventBus,
    sessionStore: SessionStore,
    channelId: string,
    conversationId: string,
    runtimes: ReadonlyMap<AgentRuntime["kind"], AgentRuntime> = DEFAULT_RUNTIMES,
  ) {
    for (const profile of profiles) {
      const runtime = runtimes.get(profile.runtime);
      if (!runtime) {
        throw new Error(`No runtime configured for ${profile.runtime}`);
      }

      this.sessions.set(
        profile.id,
        new AgentSession({
          id: profile.id,
          label: profile.name,
          cwd: profile.cwd,
          permissionProfile: profile.permissionProfile,
          runtime,
          eventBus,
          sessionStore,
          channelId,
          conversationId,
        }),
      );
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
      runtime: profile.runtime,
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
