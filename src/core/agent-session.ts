import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentId, AgentStatus } from "../shared/types.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { runClaudeCli } from "./claude-cli-runtime.ts";
import { isCleanFinalAnswer } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  eventBus: EventBus;
  quietWindowMs?: number;
};

type ActiveRun = {
  runId: string;
  child: ChildProcessWithoutNullStreams;
};

export class AgentSession {
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;

  constructor(private readonly options: AgentSessionOptions) {}

  get id(): AgentId {
    return this.options.id;
  }

  get label(): string {
    return this.options.label;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  start(): void {
    if (this.status === "stopped" || this.status === "starting") {
      this.setStatus("idle");
    }
  }

  send(runId: string, prompt: string): Promise<string> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    this.setStatus("running");
    const handle = runClaudeCli({
      agentId: this.id,
      cwd: this.options.cwd,
      prompt,
      onOutput: (text) => {
        this.options.eventBus.publish({ type: "terminal.chunk", agentId: this.id, runId, text });
      },
    });
    this.activeRun = { runId, child: handle.process };

    return handle.result
      .then((result) => {
        this.activeRun = null;
        this.setStatus("idle");
        const cleaned = sanitizeAgentVisibleReply(result.trim());
        if (!isCleanFinalAnswer(cleaned)) {
          throw new Error("Agent did not return a clean final answer.");
        }
        return cleaned;
      })
      .catch((error: unknown) => {
        this.activeRun = null;
        this.setStatus("error");
        throw error;
      });
  }

  stop(): void {
    if (this.activeRun) {
      this.activeRun.child.kill();
      this.activeRun = null;
    }

    this.setStatus("stopped");
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.options.eventBus.publish({
      type: "agent.status",
      agentId: this.id,
      status,
    });
  }
}
