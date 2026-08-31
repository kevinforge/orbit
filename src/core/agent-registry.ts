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

  /**
   * 更新员工的首选模型（issue #153）。只改 profile 与会话内的偏好，
   * 不重建会话、不取消排队/运行中的任务；偏好在每次运行开始时惰性应用，
   * 因此新值从该员工的下一次运行开始生效。
   */
  updatePreferredModel(agentId: AgentId, preferredModelId?: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) return false;
    const trimmed = preferredModelId?.trim() || undefined;
    this.profilesById = this.profilesById.map((profile) => {
      if (profile.id !== agentId) return profile;
      const { preferredModelId: _previous, ...rest } = profile;
      return trimmed ? { ...rest, preferredModelId: trimmed } : rest;
    });
    session.setPreferredModelId(trimmed);
    return true;
  }

  /** 当前注册员工的 profile（含运行期更新后的偏好）。 */
  profile(agentId: AgentId): AgentProfile | undefined {
    return this.profilesById.find((profile) => profile.id === agentId);
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
