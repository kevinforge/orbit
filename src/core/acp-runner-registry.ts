import type { AgentRuntimeKind } from "../shared/types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";
import {
  CLAUDE_ACP,
  claudeCodeRuntime,
  resolveClaudeAcpCommand,
} from "./claude-acp-runtime.ts";
import {
  CODEBUDDY_ACP,
  codeBuddyRuntime,
} from "./codebuddy-acp-runtime.ts";
import {
  CODEX_ACP,
  codexRuntime,
  resolveCodexAcpCommand,
} from "./codex-acp-runtime.ts";
import type { AcpRuntimeDefinition } from "./acp-runtime.ts";

export type AcpRunnerRegistration = {
  kind: AgentRuntimeKind;
  availabilityKey: string;
  definition: AcpRuntimeDefinition;
  runtime: AgentRuntime;
  resolveProbeCommand: (env?: NodeJS.ProcessEnv) => string;
};

export class AcpRunnerRegistry {
  private readonly registrations = new Map<AgentRuntimeKind, AcpRunnerRegistration>();

  constructor(registrations: readonly AcpRunnerRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: AcpRunnerRegistration): void {
    if (registration.kind !== registration.definition.kind || registration.kind !== registration.runtime.kind) {
      throw new Error(`ACP runner registration kind mismatch for ${registration.kind}.`);
    }
    if (this.registrations.has(registration.kind)) {
      throw new Error(`ACP runner already registered: ${registration.kind}`);
    }
    this.registrations.set(registration.kind, registration);
  }

  get(kind: AgentRuntimeKind): AcpRunnerRegistration | undefined {
    return this.registrations.get(kind);
  }

  list(): AcpRunnerRegistration[] {
    return [...this.registrations.values()];
  }

  runtimeMap(): ReadonlyMap<AgentRuntimeKind, AgentRuntime> {
    return new Map(this.list().map((registration) => [registration.kind, registration.runtime]));
  }
}

export const defaultAcpRunnerRegistry = new AcpRunnerRegistry([
  {
    kind: "claude-code",
    availabilityKey: "claude-agent-acp",
    definition: CLAUDE_ACP,
    runtime: claudeCodeRuntime,
    resolveProbeCommand: resolveClaudeAcpCommand,
  },
  {
    kind: "codex",
    availabilityKey: "codex-acp",
    definition: CODEX_ACP,
    runtime: codexRuntime,
    resolveProbeCommand: resolveCodexAcpCommand,
  },
  {
    kind: "codebuddy",
    availabilityKey: "codebuddy",
    definition: CODEBUDDY_ACP,
    runtime: codeBuddyRuntime,
    resolveProbeCommand: () => "codebuddy",
  },
]);

export const DEFAULT_AGENT_RUNTIMES = defaultAcpRunnerRegistry.runtimeMap();
