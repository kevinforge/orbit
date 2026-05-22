import os from "node:os";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

import type { AgentId, AgentStatus } from "../shared/types.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";
import { sanitizeAgentVisibleReply } from "./agent-prompt.ts";
import { extractClaudeAssistantReply, shouldCompleteFromTerminalOutput } from "./claude-output-detector.ts";
import { EventBus } from "./event-bus.ts";
import { QuietWindowTurnDetector } from "./turn-detector.ts";

export type AgentSessionOptions = {
  id: AgentId;
  label: string;
  cwd: string;
  eventBus: EventBus;
  quietWindowMs?: number;
};

type ActiveRun = {
  runId: string;
  rawStartOffset: number;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};

const DEFAULT_QUIET_WINDOW_MS = Number(process.env.ORBIT_TURN_QUIET_MS ?? 180000);
const COMPLETION_CHECK_INTERVAL_MS = 1000;

export class AgentSession {
  private term: IPty | null = null;
  private rawOutput = "";
  private status: AgentStatus = "stopped";
  private activeRun: ActiveRun | null = null;
  private readonly turnDetector: QuietWindowTurnDetector;
  private completionTimer: NodeJS.Timeout | null = null;
  private bypassWarningAccepted = false;

  constructor(private readonly options: AgentSessionOptions) {
    this.turnDetector = new QuietWindowTurnDetector(options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS);
  }

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
    if (this.term) {
      return;
    }

    this.setStatus("starting");
    const command = os.platform() === "win32" ? "claude.cmd" : "claude";
    this.term = pty.spawn(command, ["--permission-mode", "bypassPermissions"], {
      name: "xterm-color",
      cols: 140,
      rows: 44,
      cwd: this.options.cwd,
      env: this.createEnv(),
    });

    this.term.onData((chunk) => {
      this.rawOutput += chunk;
      this.acceptBypassWarningIfNeeded(chunk);
      this.turnDetector.markOutput();

      const text = extractReadableText(chunk);
      if (text) {
        this.options.eventBus.publish({
          type: "terminal.chunk",
          agentId: this.id,
          runId: this.activeRun?.runId,
          text,
        });
      }

      if (this.status === "starting") {
        this.setStatus("idle");
      }

      this.scheduleCompletionCheck();
    });

    this.term.onExit(({ exitCode }) => {
      this.term = null;
      this.clearCompletionTimer();

      const activeRun = this.activeRun;
      this.activeRun = null;

      if (activeRun) {
        activeRun.reject(new Error(`${this.id} exited during run with code ${exitCode}`));
        this.setStatus("error");
      } else {
        this.setStatus("stopped");
      }
    });
  }

  send(runId: string, prompt: string): Promise<string> {
    if (this.activeRun) {
      return Promise.reject(new Error(`${this.id} is already running`));
    }

    if (!this.term) {
      this.start();
    }

    if (!this.term) {
      return Promise.reject(new Error(`Failed to start ${this.id}`));
    }

    this.setStatus("running");
    this.turnDetector.markOutput();

    const rawStartOffset = this.rawOutput.length;
    const result = new Promise<string>((resolve, reject) => {
      this.activeRun = { runId, rawStartOffset, resolve, reject };
    });

    this.term.write(`${prompt}\r`);
    this.scheduleCompletionCheck();

    return result;
  }

  writeRaw(input: string): void {
    if (!this.term) {
      this.start();
    }
    this.term?.write(input);
  }

  completeFromHook(lastAssistantMessage: string): boolean {
    const activeRun = this.activeRun;
    if (!activeRun) {
      return false;
    }

    this.activeRun = null;
    this.clearCompletionTimer();
    this.setStatus("idle");
    activeRun.resolve(sanitizeAgentVisibleReply(lastAssistantMessage.trim()) || "Agent did not produce readable output.");
    return true;
  }

  stop(): void {
    this.clearCompletionTimer();

    if (this.activeRun) {
      this.activeRun.reject(new Error(`${this.id} was stopped`));
      this.activeRun = null;
    }

    if (this.term) {
      this.term.kill();
      this.term = null;
    }

    this.setStatus("stopped");
  }

  private scheduleCompletionCheck(): void {
    if (!this.activeRun || this.completionTimer) {
      return;
    }

    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      this.checkCompletion();
    }, COMPLETION_CHECK_INTERVAL_MS);
  }

  private checkCompletion(): void {
    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }

    const rawRunOutput = this.rawOutput.slice(activeRun.rawStartOffset);
    if (
      !shouldCompleteFromTerminalOutput(rawRunOutput, this.turnDetector.isQuiet(), this.isStopHookCompletionEnabled())
    ) {
      this.scheduleCompletionCheck();
      return;
    }

    this.activeRun = null;
    const cleanedOutput = extractClaudeAssistantReply(rawRunOutput);
    this.setStatus("idle");
    activeRun.resolve(sanitizeAgentVisibleReply(cleanedOutput) || "Agent did not produce readable output.");
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

  private acceptBypassWarningIfNeeded(chunk: string): void {
    if (this.bypassWarningAccepted || process.env.ORBIT_AUTO_ACCEPT_BYPASS_WARNING === "0") {
      return;
    }

    const output = `${this.rawOutput}${chunk}`;
    if (!/BypassPermissions/i.test(output) || !/accept/i.test(output)) {
      return;
    }

    this.bypassWarningAccepted = true;
    this.term?.write("\x1b[B");
    setTimeout(() => {
      this.term?.write("\r");
    }, 100);
  }

  private clearCompletionTimer(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }

  private isStopHookCompletionEnabled(): boolean {
    return process.env.ORBIT_DISABLE_CLAUDE_STOP_HOOK !== "1";
  }

  private createEnv(): Record<string, string> {
    return {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      ORBIT_AGENT_ID: this.id,
      ORBIT_HOOK_URL: process.env.ORBIT_HOOK_URL ?? "http://localhost:4317/api/hooks/claude-stop",
    };
  }
}
