import type { AgentId, AgentProfile, AgentState, ElicitationResponse, PendingElicitation, PendingPermission, PermissionDecision } from "../shared/types.ts";
import { AgentSession, type AgentModelStateBridge } from "./agent-session.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import { DEFAULT_AGENT_RUNTIMES } from "./acp-runner-registry.ts";
import { EventBus } from "./event-bus.ts";
import type { SessionStore } from "./session-store.ts";

export class AgentRegistry {
  private readonly sessions = new Map<AgentId, AgentSession>();
  private profilesById: AgentProfile[];

  constructor(
    profiles: readonly AgentProfile[],
    private readonly eventBus: EventBus,
    private readonly sessionStore: SessionStore,
    private readonly conversationId: string,
    private readonly runtimes: ReadonlyMap<AgentRuntime["kind"], AgentRuntime> = DEFAULT_AGENT_RUNTIMES,
    private readonly modelState?: AgentModelStateBridge,
    private readonly workspaceId?: string,
  ) {
    this.profilesById = [...profiles];
    for (const profile of profiles) {
      this.createSession(profile);
    }
  }

  private createSession(profile: AgentProfile): void {
    const runtime = this.runtimes.get(profile.runtime);
    if (!runtime) throw new Error(`No runtime configured for ${profile.runtime}`);
    this.sessions.set(profile.id, new AgentSession({
      id: profile.id,
      label: profile.name,
      cwd: profile.cwd,
      runtime,
      eventBus: this.eventBus,
      sessionStore: this.sessionStore,
      conversationId: this.conversationId,
      workspaceId: this.workspaceId,
      ...(profile.preferredModelId ? { preferredModelId: profile.preferredModelId } : {}),
      ...(this.modelState ? { modelState: this.modelState } : {}),
    }));
  }

  startAll(): void {
    for (const session of this.sessions.values()) {
      session.start();
    }
  }

  has(agentId: AgentId): boolean {
    return this.sessions.has(agentId);
  }

  get(agentId: AgentId): AgentSession {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return session;
  }

  ids(): AgentId[] {
    return this.profilesById.filter((profile) => !profile.internal).map((profile) => profile.id);
  }

  allIds(): AgentId[] {
    return this.profilesById.map((profile) => profile.id);
  }

  hasRunningAgent(): boolean {
    return [...this.sessions.values()].some((session) => session.getStatus() === "running");
  }

  states(): AgentState[] {
    return this.profilesById.filter((profile) => !profile.internal).map((profile, index) => ({
      id: profile.id,
      label: profile.name,
      runtime: profile.runtime,
      triggers: profile.triggers,
      status: this.get(profile.id).getStatus(),
      selected: index === 0,
    }));
  }

  add(profile: AgentProfile): void {
    if (this.sessions.has(profile.id)) return;
    this.profilesById.push(profile);
    this.createSession(profile);
    this.sessions.get(profile.id)?.start();
  }

  remove(agentId: AgentId): void {
    const session = this.sessions.get(agentId);
    if (!session) return;
    session.stop();
    this.sessions.delete(agentId);
    this.profilesById = this.profilesById.filter((profile) => profile.id !== agentId);
  }

  pendingPermissions(): PendingPermission[] {
    return [...this.sessions.values()].flatMap((session) => session.pendingPermissions());
  }

  pendingElicitations(): PendingElicitation[] {
    return [...this.sessions.values()].flatMap((session) => session.pendingElicitations());
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolvePermission(requestId, decision)) {
        return true;
      }
    }
    return false;
  }

  resolveElicitation(requestId: string, response: ElicitationResponse): boolean {
    for (const session of this.sessions.values()) {
      if (session.resolveElicitation(requestId, response)) {
        return true;
      }
    }
    return false;
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.stop();
    }
  }
}
