import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type ContentBlock,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type SessionNotification,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentActivityEvent, AgentId, PermissionProfile } from "../shared/types.ts";
import type { AgentRuntime, AgentRuntimeRunHandle, AgentRuntimeRunOptions } from "./agent-runtime.ts";
import { interruptProcessTree } from "./claude-cli-runtime.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";

const CANCEL_GRACE_MS = 1_500;

export type CodeBuddyAcpRunOptions = AgentRuntimeRunOptions;

export type CodeBuddyAcpConnection = {
  readonly pid: number;
  initialize(request: InitializeRequest): Promise<InitializeResponse>;
  newSession(request: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(request: LoadSessionRequest): Promise<void>;
  resumeSession(request: ResumeSessionRequest): Promise<void>;
  prompt(request: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  close(): void;
};

export type CodeBuddyAcpConnector = (
  options: CodeBuddyAcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
) => CodeBuddyAcpConnection;

type ToolState = {
  name: string;
  status?: ToolCallStatus | null;
};

export function buildCodeBuddyAcpArgs(): string[] {
  return ["--acp"];
}

export function buildCodeBuddyAcpCommand(): { file: string; args: string[] } {
  const args = buildCodeBuddyAcpArgs();
  if (os.platform() !== "win32") {
    return { file: "codebuddy", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "codebuddy.cmd", ...args] };
}

export function createCodeBuddyAcpRuntime(
  connector: CodeBuddyAcpConnector = spawnCodeBuddyAcpConnection,
): AgentRuntime {
  return {
    kind: "codebuddy",
    transport: "acp",
    protocolVersion: PROTOCOL_VERSION,
    run: (options) => runCodeBuddyAcp(options, connector),
  };
}

export function runCodeBuddyAcp(
  options: CodeBuddyAcpRunOptions,
  connector: CodeBuddyAcpConnector = spawnCodeBuddyAcpConnection,
): AgentRuntimeRunHandle {
  let acceptingUpdates = false;
  let activeSessionId: string | null = null;
  let cancelled = false;
  let closed = false;
  let cancelTimer: NodeJS.Timeout | null = null;
  const answerParts: string[] = [];
  const toolStates = new Map<string, ToolState>();

  const connection = connector(options, (notification) => {
    if (!acceptingUpdates || notification.sessionId !== activeSessionId) {
      return;
    }
    handleSessionUpdate(notification, answerParts, toolStates, options);
  });

  let resolveSessionId!: (sessionId: string | null) => void;
  let sessionIdSettled = false;
  const sessionId = new Promise<string | null>((resolve) => {
    resolveSessionId = (value) => {
      if (sessionIdSettled) return;
      sessionIdSettled = true;
      resolve(value);
    };
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (cancelTimer) clearTimeout(cancelTimer);
    connection.close();
  };

  const result = (async () => {
    try {
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Orbit", version: "1.0.0" },
      });
      validateInitializeResponse(initialized);

      activeSessionId = await prepareSession(
        connection,
        initialized.agentCapabilities,
        options.cwd,
        options.resumeSessionId,
      );
      resolveSessionId(activeSessionId);

      acceptingUpdates = true;
      const response = await connection.prompt({
        sessionId: activeSessionId,
        prompt: buildPromptContent(options.prompt, options.imagePaths, initialized.agentCapabilities),
      });
      acceptingUpdates = false;

      if (cancelled || response.stopReason === "cancelled") {
        throw new Error("CodeBuddy ACP turn was cancelled.");
      }
      if (response.stopReason === "refusal") {
        throw new Error("CodeBuddy ACP refused the request.");
      }

      const answer = answerParts.join("").trim();
      if (!answer) {
        throw new Error(`CodeBuddy ACP completed with ${response.stopReason} but no final answer.`);
      }
      return answer;
    } finally {
      acceptingUpdates = false;
      resolveSessionId(activeSessionId);
      close();
    }
  })();

  const interrupt = () => {
    if (cancelled || closed) return;
    cancelled = true;
    if (!activeSessionId) {
      close();
      return;
    }

    void connection.cancel(activeSessionId).catch(() => close());
    cancelTimer = setTimeout(close, CANCEL_GRACE_MS);
    cancelTimer.unref?.();
  };

  return {
    process: {
      kill: close,
      pid: connection.pid,
      interrupt,
    },
    result,
    sessionId,
  };
}

async function prepareSession(
  connection: CodeBuddyAcpConnection,
  capabilities: AgentCapabilities | undefined,
  cwd: string,
  existingSessionId?: string,
): Promise<string> {
  const absoluteCwd = path.resolve(cwd);
  if (!existingSessionId) {
    const created = await connection.newSession({ cwd: absoluteCwd, mcpServers: [] });
    return created.sessionId;
  }

  const request = {
    sessionId: existingSessionId,
    cwd: absoluteCwd,
    mcpServers: [],
  };
  if (capabilities?.sessionCapabilities?.resume) {
    await connection.resumeSession(request satisfies ResumeSessionRequest);
    return existingSessionId;
  }
  if (capabilities?.loadSession) {
    await connection.loadSession(request);
    return existingSessionId;
  }

  throw new Error(
    "CodeBuddy ACP could not resume the session because the agent does not advertise session/load or session/resume.",
  );
}

function validateInitializeResponse(response: InitializeResponse): void {
  if (response.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported CodeBuddy ACP protocol version ${response.protocolVersion}; Orbit requires ${PROTOCOL_VERSION}.`,
    );
  }
}

function buildPromptContent(
  prompt: string,
  imagePaths: string[] | undefined,
  capabilities: AgentCapabilities | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  if (!imagePaths?.length) return blocks;

  if (!capabilities?.promptCapabilities?.image) {
    blocks.push({
      type: "text",
      text: `\nAttached image paths:\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`,
    });
    return blocks;
  }

  for (const imagePath of imagePaths) {
    blocks.push({
      type: "image",
      data: fs.readFileSync(imagePath).toString("base64"),
      mimeType: imageMimeType(imagePath),
      uri: pathToFileUri(imagePath),
    });
  }
  return blocks;
}

function imageMimeType(imagePath: string): string {
  switch (path.extname(imagePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function pathToFileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

function handleSessionUpdate(
  notification: SessionNotification,
  answerParts: string[],
  toolStates: Map<string, ToolState>,
  options: CodeBuddyAcpRunOptions,
): void {
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      answerParts.push(update.content.text);
      options.onOutput?.(update.content.text);
    }
    return;
  }

  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return;
  }

  const previous = toolStates.get(update.toolCallId);
  const name = update.name ?? update.title ?? previous?.name ?? update.kind ?? "tool";
  const status = update.status ?? previous?.status;
  toolStates.set(update.toolCallId, { name, status });

  if (!previous && status !== "completed" && status !== "failed") {
    emitActivity(options, {
      type: "tool.started",
      name,
      ...(update.rawInput === undefined ? {} : { input: formatValue(update.rawInput) }),
      timestamp: new Date().toISOString(),
    });
  }
  if (status === "completed" && previous?.status !== "completed") {
    emitActivity(options, {
      type: "tool.completed",
      name,
      ...(update.rawOutput === undefined ? {} : { summary: formatValue(update.rawOutput) }),
      timestamp: new Date().toISOString(),
    });
  }
  if (status === "failed" && previous?.status !== "failed") {
    emitActivity(options, {
      type: "tool.failed",
      name,
      ...(update.rawOutput === undefined ? {} : { summary: formatValue(update.rawOutput) }),
      timestamp: new Date().toISOString(),
    });
  }
}

function emitActivity(options: CodeBuddyAcpRunOptions, activity: AgentActivityEvent): void {
  options.onActivity?.(activity);
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export function decideCodeBuddyPermission(
  request: RequestPermissionRequest,
  profile: PermissionProfile,
  cwd: string,
): RequestPermissionResponse {
  const allowed = isToolAllowed(request.toolCall.kind, request.toolCall.rawInput, profile)
    && areLocationsAllowed(request.toolCall.locations, profile, cwd);
  return selectCodeBuddyPermission(request, allowed ? "allow" : "reject");
}

export async function resolveCodeBuddyPermission(
  request: RequestPermissionRequest,
  options: CodeBuddyAcpRunOptions,
): Promise<RequestPermissionResponse> {
  const allowed = isToolAllowed(request.toolCall.kind, request.toolCall.rawInput, options.permissionProfile)
    && areLocationsAllowed(request.toolCall.locations, options.permissionProfile, options.cwd);
  if (!allowed || options.approvalMode !== "full-access") {
    if (!allowed || !options.requestPermission) {
      return selectCodeBuddyPermission(request, "reject");
    }

    const decision = await options.requestPermission({
      id: request.toolCall.toolCallId,
      title: request.toolCall.title || toolKindLabel(request.toolCall.kind),
      ...(request.toolCall.kind ? { kind: request.toolCall.kind } : {}),
      ...(request.toolCall.rawInput === undefined ? {} : { input: formatValue(request.toolCall.rawInput) }),
      ...(request.toolCall.locations?.length
        ? { locations: request.toolCall.locations.map((location) => location.path) }
        : {}),
    });
    return selectCodeBuddyPermission(request, decision);
  }

  return selectCodeBuddyPermission(request, "allow");
}

function selectCodeBuddyPermission(
  request: RequestPermissionRequest,
  decision: "allow" | "reject",
): RequestPermissionResponse {
  const selectedKind = decision === "allow" ? "allow_once" : "reject_once";
  const selected = request.options.find((option) => option.kind === selectedKind);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function toolKindLabel(kind: ToolKind | null | undefined): string {
  switch (kind) {
    case "read": return "读取文件";
    case "search": return "搜索文件";
    case "fetch": return "访问网络";
    case "edit": return "编辑文件";
    case "delete": return "删除文件";
    case "move": return "移动文件";
    case "execute": return "执行命令";
    default: return "执行操作";
  }
}

function isToolAllowed(
  kind: ToolKind | null | undefined,
  rawInput: unknown,
  profile: PermissionProfile,
): boolean {
  switch (kind) {
    case "read":
    case "search":
      return profile.canReadFiles;
    case "fetch":
      return profile.canRunCommands;
    case "edit":
    case "delete":
    case "move":
      return profile.canWriteFiles;
    case "execute": {
      const command = formatValue(rawInput).toLowerCase();
      if (looksLikeDependencyInstall(command) && !profile.canInstallDependencies) return false;
      if (looksLikeGitWrite(command) && !profile.canGitCommit) return false;
      return profile.canRunCommands;
    }
    case "think":
    case "switch_mode":
      return true;
    case "other":
    default:
      return profile.canRunCommands && profile.canWriteFiles;
  }
}

function looksLikeDependencyInstall(command: string): boolean {
  return /\b(npm\s+(install|i)|pnpm\s+(add|install)|yarn\s+add|bun\s+add|pip\s+install|cargo\s+add|brew\s+install|apt(-get)?\s+install)\b/.test(command);
}

function looksLikeGitWrite(command: string): boolean {
  return /\bgit\s+(commit|push|tag|merge|rebase|reset|checkout|switch|branch\s+-[dD])\b/.test(command);
}

function areLocationsAllowed(
  locations: RequestPermissionRequest["toolCall"]["locations"],
  profile: PermissionProfile,
  cwd: string,
): boolean {
  if (!locations?.length) return true;
  const roots = profile.allowedDirectories.map((directory) => path.resolve(cwd, directory));
  return locations.every((location) => roots.some((root) => isPathInside(root, path.resolve(location.path))));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function spawnCodeBuddyAcpConnection(
  options: CodeBuddyAcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
): CodeBuddyAcpConnection {
  const command = buildCodeBuddyAcpCommand();
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: createEnv(options.agentId, options.env ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: os.platform() !== "win32",
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const readable = extractReadableText(chunk);
    if (readable) options.onOutput?.(readable);
  });

  const app = client({ name: "Orbit" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => (
      resolveCodeBuddyPermission(params, options)
    ))
    .onNotification(methods.client.session.update, ({ params }) => {
      onSessionUpdate(params);
    });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const acp = app.connect(stream);

  return connectionFromProcess(child, acp);
}

function connectionFromProcess(
  child: ChildProcessWithoutNullStreams,
  acp: ClientConnection,
): CodeBuddyAcpConnection {
  const pid = child.pid ?? 0;
  let closed = false;
  let rejectProcessFailure!: (error: Error) => void;
  const processFailure = new Promise<never>((_resolve, reject) => {
    rejectProcessFailure = reject;
  });
  child.once("error", (error) => rejectProcessFailure(error));
  child.once("exit", (code, signal) => {
    if (!closed) {
      rejectProcessFailure(new Error(
        `CodeBuddy ACP process exited unexpectedly (${code === null ? signal : `code ${code}`}).`,
      ));
    }
  });
  const request = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, processFailure]);

  const close = () => {
    if (closed) return;
    closed = true;
    if (pid > 0) {
      if (os.platform() === "win32") {
        // Finish tree termination before closing stdio. If cmd.exe exits first,
        // taskkill can no longer discover and terminate CodeBuddy's Node child.
        spawnSync("taskkill", ["/pid", String(pid), "/F", "/T"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        interruptProcessTree(pid);
      }
    } else {
      child.kill();
    }
    acp.close();
  };

  return {
    pid,
    initialize: (params) => request(acp.agent.request(methods.agent.initialize, params)),
    newSession: (params) => request(acp.agent.request(methods.agent.session.new, params)),
    loadSession: async (params) => {
      await request(acp.agent.request(methods.agent.session.load, params));
    },
    resumeSession: async (params) => {
      await request(acp.agent.request(methods.agent.session.resume, params));
    },
    prompt: (params) => request(acp.agent.request(methods.agent.session.prompt, params)),
    cancel: (sessionId) => request(acp.agent.notify(methods.agent.session.cancel, { sessionId })),
    close,
  };
}

function createEnv(agentId: AgentId, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ORBIT_AGENT_ID: agentId,
    CODEBUDDY_AGENT_ID: agentId,
  };
}

export const codeBuddyRuntime = createCodeBuddyAcpRuntime();
