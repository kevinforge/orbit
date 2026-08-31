import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown, LOCAL_PATH_LINK_CLASS } from "./markdown-renderer.ts";
import { isSafeExternalUrl } from "./url-guard.ts";
import { AGENT_RUNTIME_PRIORITY, runtimeKindToCliKey, runtimeMeta } from "../core/runtime-meta.ts";
import { INTERNAL_SUPERVISOR_ID } from "../core/agent-profiles.ts";
import { matchPreset } from "../core/workspace-presets.ts";
import { type AgentActivityEvent, type AgentConfig, type AgentConfigWithModelState, type AgentId, type AgentModelPreference, type AgentModelProbeResponse, type AgentModelProbeState, type AgentModelStateSnapshot, type AgentPlanSnapshot, type AgentRuntimeKind, type AgentState, type AgentTeamTemplate, type AppState, type ApprovalMode, type ChatMessage, type Conversation, type ConversationInfo, type DraftAttachmentInfo, type ElicitationContent, type ElicitationFieldSchema, type ElicitationResponse, type InteractionMode, type MessagePage, type PendingElicitation, type PendingPermission, type PermissionDecision, type PersistedProcessTimelineEntry, type RunningSummary, type RuntimeEvent, type SupervisorConfig, type Workspace, type WorkspacePreset, ATTACHMENT_LIMITS } from "../shared/types.ts";
import { attachmentAcceptAttribute } from "../shared/attachment-registry.ts";
import { createAttachmentUploadLifecycle } from "./attachment-upload-state.ts";
import { appendTransientProcessActivity, collapseToolExecutions, type ProcessToolActivity, type ProcessToolExecution } from "../shared/process-activity.ts";
import { WorkAnalysisPanel } from "./WorkAnalysisPanel.tsx";
import * as TDesign from "tdesign-react";
import {
  AddIcon,
  AttachIcon,
  ChartIcon,
  CheckIcon,
  ChatBubbleHistoryIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  FolderIcon,
  MoreIcon,
  ArrowDownIcon,
  SecuredIcon,
  SendIcon,
  SettingIcon,
  StopCircleIcon,
  TerminalIcon,
  UsergroupIcon,
} from "tdesign-icons-react";

const { Avatar, Button, Tooltip } = TDesign;

/** 会话交互模式的展示元数据：顺序即菜单顺序，label/tooltip 均为产品文案。 */
const INTERACTION_MODE_META: Array<{ mode: InteractionMode; label: string; tooltip: string }> = [
  { mode: "direct", label: "普通对话", tooltip: "与一位数字员工持续交流，不会转交或指派其他员工。" },
  { mode: "collaborative", label: "简单协作", tooltip: "数字员工可按需邀请或转交任务，不启用监工。" },
  { mode: "supervised", label: "复杂协作", tooltip: "启用内置监工，自动拆解任务、调度员工、跟踪进度并推动闭环。" },
];

function interactionModeLabel(mode: InteractionMode): string {
  return INTERACTION_MODE_META.find((meta) => meta.mode === mode)?.label ?? mode;
}

function interactionModeTooltip(mode: InteractionMode): string {
  return INTERACTION_MODE_META.find((meta) => meta.mode === mode)?.tooltip ?? mode;
}

const initialState: AppState = {
  workspace: { id: "", name: "", path: "" },
  conversation: { id: "", name: "", interactionMode: "direct" },
  agents: [],
  messages: [],
  messageHistory: { hasOlderMessages: false, olderCursor: null },
  terminal: {},
  runningSummaries: [],
  runtimeAvailability: [],
  pendingPermissions: [],
  pendingElicitations: [],
  agentModelStates: {},
};

type ActiveView = "conversation" | "analysis";
const ACTIVE_VIEW_STORAGE_KEY = "orbit.activeView";
const APPROVAL_MODE_STORAGE_KEY = "orbit.approvalMode";

export type PageContext = { workspaceId: string; conversationId: string };

export function readPageContext(search: string): PageContext {
  const params = new URLSearchParams(search);
  return {
    workspaceId: params.get("workspaceId") ?? "",
    conversationId: params.get("conversationId") ?? "",
  };
}

function pageContextQuery(context: PageContext): string {
  const params = new URLSearchParams();
  if (context.workspaceId) params.set("workspaceId", context.workspaceId);
  if (context.conversationId) params.set("conversationId", context.conversationId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function withPageContext(path: string, context: PageContext): string {
  const separator = path.includes("?") ? "&" : "?";
  const query = pageContextQuery(context).slice(1);
  return query ? `${path}${separator}${query}` : path;
}

export function resolveActiveView(storedView: string | null): ActiveView {
  return storedView === "analysis" ? "analysis" : "conversation";
}

function loadActiveView(): ActiveView {
  try {
    return resolveActiveView(window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY));
  } catch {
    return "conversation";
  }
}

export function resolveApprovalMode(storedMode: string | null): ApprovalMode {
  return storedMode === "ask" ? "ask" : "full-access";
}

function loadApprovalMode(): ApprovalMode {
  try {
    return resolveApprovalMode(window.localStorage.getItem(APPROVAL_MODE_STORAGE_KEY));
  } catch {
    return "full-access";
  }
}

/**
 * 判断按键是否发生在输入法组合（IME composition）期间。
 * macOS 中文输入法组合中按 Enter 是"字母原文上屏"、方向键用于选择候选词，
 * 这些按键必须交给输入法处理，不能触发发送、选中 @员工 等快捷键。
 * keyCode 229 兼容旧版 Safari（其组合期 keydown 不带 isComposing）。
 */
export function isImeComposition(event: { nativeEvent: { isComposing?: boolean }; keyCode?: number }): boolean {
  return event.nativeEvent.isComposing === true || event.keyCode === 229;
}

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [activeView, setActiveView] = useState<ActiveView>(loadActiveView);
  const [content, setContent] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(loadApprovalMode);
  const [showApprovalModeMenu, setShowApprovalModeMenu] = useState(false);
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<string[]>([]);
  const [resolvingElicitationIds, setResolvingElicitationIds] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("");
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [isSending, setIsSending] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [interruptToast, setInterruptToast] = useState<string | null>(null);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showNewMessageHint, setShowNewMessageHint] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [conversationsByWorkspace, setConversationsByWorkspace] = useState<Record<string, Conversation[]>>({});
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationName, setEditingConversationName] = useState("");
  const [openWorkspaceMenuId, setOpenWorkspaceMenuId] = useState<string | null>(null);
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(() => new Set());  // non-active workspaces only; active workspace is always expanded
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [pendingWorkspacePath, setPendingWorkspacePath] = useState<string | null>(null);
  const [workspacePresets, setWorkspacePresets] = useState<WorkspacePreset[]>([]);
  useEffect(() => {
    fetch("/api/workspace-presets")
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((p: WorkspacePreset[]) => setWorkspacePresets(Array.isArray(p) ? p : []))
      .catch(() => { /* presets are optional; the picker and config panel degrade gracefully */ });
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<DraftAttachmentInfo[]>([]);
  const [attachmentToast, setAttachmentToast] = useState<string | null>(null);
  const [pathToast, setPathToast] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<DraftAttachmentInfo | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  /** 附件上传生命周期：上下文版本绑定的上传计数与附件槽位（PR #147 M1 竞态修复）。 */
  const attachmentUploadLifecycleRef = useRef(createAttachmentUploadLifecycle());
  const [uploadingAttachments, setUploadingAttachments] = useState(0);
  const [isRefreshingRuntimes, setIsRefreshingRuntimes] = useState(false);
  const [isSwitchingInteractionMode, setIsSwitchingInteractionMode] = useState(false);
  const [showInteractionModeMenu, setShowInteractionModeMenu] = useState(false);
  const [showSupervisorSettings, setShowSupervisorSettings] = useState(false);
  const isNearBottomRef = useRef(true);
  const stateRequestVersionRef = useRef(0);
  const sseLastEventIdRef = useRef(0);
  // 同一份草稿在失败重试时必须复用同一个 clientMessageId，
  // 否则服务端按 id 去重的幂等保护失效，重试会重复落库。
  // 但 id 必须与草稿内容绑定：内容改过之后要换新 id，否则服务端按旧 id 去重直接返回成功，
  // 新内容其实从未送达，用户却以为发送成功了。
  const draftMessageIdRef = useRef<{ id: string; content: string } | null>(null);

  const currentPageContext = (): PageContext => ({
    workspaceId: state.workspace.id,
    conversationId: state.conversation.id,
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, activeView);
    } catch {
      // The view still works when storage is unavailable; only reload persistence is lost.
    }
  }, [activeView]);

  useEffect(() => {
    try {
      window.localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, approvalMode);
    } catch {
      // Approval mode still applies to this tab when storage is unavailable.
    }
  }, [approvalMode]);

  const isAnyAgentRunning = state.agents.some((a) => a.status === "running");
  // messages 上的 runStatus 覆盖被 AgentRegistry.states() 过滤的 internal 监工：
  // 新建会话第一条无 @ 消息只触发监工，state.agents 全 idle 且无 queued 时，
  // 仍需通过 messages 上的 runStatus==='running' 暴露停止按钮。
  const hasAnyActiveRun = state.messages.some(
    (m) => m.runStatus === "running" || m.runStatus === "cancelling" || m.runStatus === "queued",
  );
  const hasCancellingRun = state.messages.some((m) => m.runStatus === "cancelling");
  const hasRunningOrQueued = isAnyAgentRunning || hasAnyActiveRun;
  const hasWorkspace = Boolean(state.workspace.id);
  const missingRuntimeAgents = useMemo(
    () => state.agents.filter((agent) => agent.runtimeAvailable === false),
    [state.agents],
  );
  const refreshWorkspaces = () => {
    fetch("/api/workspaces").then((r) => r.json()).then(setWorkspaces).catch(() => {});
  };
  const refreshConversations = () => {
    // Load conversations for all workspaces
    const pending = workspaces.length > 0 ? workspaces : (state.workspace.id ? [{ id: state.workspace.id }] as Workspace[] : []);
    Promise.all(
      pending.map((ws) =>
        fetch(`/api/workspaces/${ws.id}/conversations`)
          .then((r) => r.json())
          .then((convs: Conversation[]) => ({ wsId: ws.id, convs }))
          .catch(() => ({ wsId: ws.id, convs: [] as Conversation[] })),
      ),
    ).then((results) => {
      const byWs: Record<string, Conversation[]> = {};
      for (const { wsId, convs } of results) {
        byWs[wsId] = convs;
      }
      setConversationsByWorkspace((prev) => ({ ...prev, ...byWs }));
    });
  };
  const refreshState = (requestedContext: PageContext = currentPageContext()) => {
    const requestVersion = ++stateRequestVersionRef.current;
    fetch(withPageContext("/api/state", requestedContext))
      .then((r) => r.json())
      .then((nextState: AppState) => {
        const pageContext = typeof window === "undefined" ? requestedContext : readPageContext(window.location.search);
        if (requestVersion !== stateRequestVersionRef.current
          || pageContext.workspaceId !== requestedContext.workspaceId
          || pageContext.conversationId !== requestedContext.conversationId) return;
        setState(normalizeState(nextState));
      })
      .catch(() => setConnectionState("offline"));
  };

  /**
   * 保存监工配置（issue #153）。无会话时先创建会话并采用返回的会话 ID，
   * 再通过显式页面上下文保存，避免依赖全局 active 指针。
   */
  async function saveSupervisorConfig(config: SupervisorConfig): Promise<void> {
    const targetWorkspaceId = state.workspace.id;
    if (!targetWorkspaceId) throw new Error("请先选择或创建工作区。");
    let conversationId = state.conversation.id;
    if (!conversationId) {
      const createResponse = await fetch(withPageContext("/api/conversations", { workspaceId: targetWorkspaceId, conversationId: "" }), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const created = await createResponse.json() as { id?: string; message?: string };
      if (!createResponse.ok || !created.id) throw new Error(created.message ?? "创建会话失败。");
      if (readPageContext(window.location.search).workspaceId !== targetWorkspaceId) return;
      conversationId = created.id;
      // 先同步地址栏，后续请求与状态刷新都以页面上下文为准。
      window.history.replaceState(null, "", `${window.location.pathname}${pageContextQuery({ workspaceId: targetWorkspaceId, conversationId })}${window.location.hash}`);
      setState((current) => ({ ...current, conversation: { ...current.conversation, id: conversationId } }));
      refreshConversations();
    }
    const targetContext = { workspaceId: targetWorkspaceId, conversationId };
    const response = await fetch(withPageContext(`/api/conversations/${conversationId}/supervisor-config`, targetContext), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const body = await response.json() as { message?: string; conversation?: ConversationInfo };
    if (!response.ok) throw new Error(body.message ?? "保存监工设置失败。");
    const pageContext = readPageContext(window.location.search);
    if (pageContext.workspaceId !== targetContext.workspaceId
      || pageContext.conversationId !== targetContext.conversationId) return;
    if (body.conversation) {
      setState((current) => ({ ...current, conversation: { ...current.conversation, ...body.conversation! } }));
    }
  }

  async function refreshRuntimeAvailability() {
    if (isRefreshingRuntimes) return;
    setIsRefreshingRuntimes(true);
    try {
      const response = await fetch("/api/runtimes/probe", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Runtime probe failed: ${response.status}`);
      }
      const body = await response.json() as { availability?: AppState["runtimeAvailability"] };
      if (Array.isArray(body.availability)) {
        setState((current) => applyEvent(current, { type: "runtime.availability.updated", availability: body.availability! }));
      }
    } finally {
      setIsRefreshingRuntimes(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    const initialContext = typeof window === "undefined" ? { workspaceId: "", conversationId: "" } : readPageContext(window.location.search);
    const requestVersion = ++stateRequestVersionRef.current;
    fetch(withPageContext("/api/state", initialContext))
      .then((response) => {
        if (!response.ok) throw new Error(`State request failed: ${response.status}`);
        return response.json();
      })
      .then((nextState: AppState) => {
        const pageContext = typeof window === "undefined" ? initialContext : readPageContext(window.location.search);
        if (!cancelled && requestVersion === stateRequestVersionRef.current
          && pageContext.workspaceId === initialContext.workspaceId
          && pageContext.conversationId === initialContext.conversationId) {
          setState(normalizeState(nextState));
        }
      })
      .catch(() => {
        if (!cancelled) setConnectionState("offline");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Each browser tab subscribes only to its current page context. Switching
  // pages changes the URL and this effect replaces the old subscription.
  useEffect(() => {
    if (!state.workspace.id) return;
    sseLastEventIdRef.current = 0;
    const events = new EventSource(withPageContext("/events", currentPageContext()));
    events.onopen = () => setConnectionState("live");
    events.onerror = () => setConnectionState("offline");
    events.onmessage = (message) => {
      try {
        const sequence = Number(message.lastEventId);
        if (Number.isFinite(sequence) && sequence > 0) {
          if (sequence <= sseLastEventIdRef.current) return;
          sseLastEventIdRef.current = sequence;
        }
        const event = JSON.parse(message.data) as RuntimeEvent;
        if (event.type === "events.gap") {
          refreshState();
          return;
        }
        setState((current) => applyEvent(current, event));
      } catch {
        setConnectionState("offline");
      }
    };
    return () => events.close();
  }, [state.workspace.id, state.conversation.id]);

  useEffect(() => {
    if (!state.workspace.id) return;
    const next = pageContextQuery(currentPageContext());
    if (typeof window !== "undefined" && window.location.search !== next) {
      window.history.replaceState(null, "", `${window.location.pathname}${next}${window.location.hash}`);
    }
  }, [state.workspace.id, state.conversation.id]);

  // 浏览器前进/后退只改地址栏，state 不会自动跟随。必须按新的页面上下文重新拉状态，
  // 否则 UI 与地址栏脱节，后续 refreshState 的上下文校验还会把新结果当成过期响应丢弃。
  useEffect(() => {
    const handlePopState = () => {
      refreshState(readPageContext(window.location.search));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Load workspace and conversation lists
  useEffect(() => {
    refreshWorkspaces();
  }, [state.workspace.id, state.conversation.id]);

  // 切换工作区或会话时：作废进行中的上传（旧请求完成后不得回写新会话的
  // 输入区或递减新会话的计数与槽位），并清空输入区附件，避免预览 URL 指
  // 向错误的工作区/会话路径（PR #147 M1）。
  useLayoutEffect(() => {
    attachmentUploadLifecycleRef.current.resetContext();
    setUploadingAttachments(0);
    setPendingAttachments([]);
  }, [state.workspace.id, state.conversation.id]);

  // Auto-expand the active workspace on initial load
  useEffect(() => {
    if (state.workspace.id && !expandedWorkspaceIds.has(state.workspace.id)) {
      setExpandedWorkspaceIds((ids) => {
        const next = new Set(ids);
        next.add(state.workspace.id);
        return next;
      });
    }
  }, [state.workspace.id]);

  // Refresh conversations when workspaces list changes
  useEffect(() => {
    if (workspaces.length === 0 && !state.workspace.id) return;
    refreshConversations();
  }, [workspaces, state.workspace.id]);

  // 监工的运行时与模型偏好来自会话级配置（issue #153）。
  const supervisorConfig: SupervisorConfig = state.conversation.supervisorConfig
    ?? { runtime: preferredSupervisionRuntime(state.runtimeAvailability) ?? "codebuddy" };
  const agentsById = useMemo(() => {
    const agents = new Map(state.agents.map((agent) => [agent.id, agent]));
    // 监工是内部员工，通常不在服务端员工列表里；若服务端返回了就保留其真实状态，
    // 不要强制覆盖成 idle。
    if (!agents.has(INTERNAL_SUPERVISOR_ID)) {
      agents.set(INTERNAL_SUPERVISOR_ID, {
        id: INTERNAL_SUPERVISOR_ID,
        label: "监工",
        runtime: supervisorConfig.runtime,
        status: "idle",
      });
    }
    return agents;
  }, [state.agents, supervisorConfig.runtime]);
  const messagesById = useMemo(() => new Map(state.messages.map((message) => [message.id, message])), [state.messages]);
  const visibleMessages = useMemo(() => state.messages.filter((message) => !message.discarded), [state.messages]);
  const agentIds = useMemo(() => state.agents.map((agent) => agent.id), [state.agents]);
  const hasEnabledAgent = agentIds.length > 0;
  const interactionMode: InteractionMode = state.conversation.interactionMode ?? "direct";
  const lastDirectAgentLabel = state.conversation.lastDirectAgentId
    ? agentsById.get(state.conversation.lastDirectAgentId)?.label
    : undefined;
  const scrollKey = useMemo(
    () =>
      state.messages
        .map((message) =>
          [
            message.id,
            message.status ?? "",
            message.content.length,
            message.activity?.length ?? 0,
            message.processTimeline?.length ?? 0,
            message.plan ? "plan" : "",
          ].join(":"),
        )
        .join("|"),
    [state.messages],
  );
  const mentionDraft = useMemo(() => findMentionDraft(content, cursorIndex), [content, cursorIndex]);
  const mentionCandidates = useMemo(() => {
    if (!inputFocused || !mentionDraft) {
      return [];
    }

    const query = mentionDraft.query.toLowerCase();
    const matched = state.agents.filter((agent) => agent.label.toLocaleLowerCase().startsWith(query)).map((agent) => agent.id);
    return matched;
  }, [agentIds, inputFocused, mentionDraft, state.agents]);

  useEffect(() => {
    if (!agentsById.has(selectedAgent) && agentIds[0]) {
      setSelectedAgent(agentIds[0]);
    }
  }, [agentIds, agentsById, selectedAgent]);

  useEffect(() => {
    if (sidebarCollapsed) return;
    window.localStorage.setItem("orbit.sidebarWidth", String(sidebarWidth));
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    if (!isResizingSidebar) return;
    function handlePointerMove(event: PointerEvent) {
      setSidebarWidth(clampSidebarWidth(event.clientX));
    }
    function handlePointerUp() {
      setIsResizingSidebar(false);
      document.body.classList.remove("sidebarResizing");
    }
    document.body.classList.add("sidebarResizing");
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.body.classList.remove("sidebarResizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionDraft?.query]);

  useEffect(() => {
    if (!openWorkspaceMenuId && !openConversationMenuId) return;

    function closeMenusOnOutsideClick(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(".rowMenuWrap")) {
        return;
      }
      setOpenWorkspaceMenuId(null);
      setOpenConversationMenuId(null);
    }

    function closeMenusOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpenWorkspaceMenuId(null);
      setOpenConversationMenuId(null);
    }

    document.addEventListener("pointerdown", closeMenusOnOutsideClick);
    document.addEventListener("keydown", closeMenusOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenusOnOutsideClick);
      document.removeEventListener("keydown", closeMenusOnEscape);
    };
  }, [openWorkspaceMenuId, openConversationMenuId]);

  function handleMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    isNearBottomRef.current = near;
    setIsNearBottom(near);
    if (near) setShowNewMessageHint(false);
  }

  function showPathToast(message: string) {
    setPathToast(message);
    window.setTimeout(() => setPathToast(null), 3000);
  }

  // 消息区事件委托：markdown 渲染出的本地路径入口（issue #143）点击或
  // Enter/Space 激活后调用 /api/local-path/reveal 在资源管理器中定位；
  // 失败或越界时提示原因，并把路径复制到剪贴板兜底。
  function localPathEntryFromEventTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest<HTMLElement>(`.${LOCAL_PATH_LINK_CLASS}`);
  }

  async function revealLocalPath(path: string) {
    let reason = "";
    try {
      const response = await fetch("/api/local-path/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (response.ok && data.ok) return;
      reason = data.message ?? "无法在资源管理器中定位该路径";
    } catch {
      reason = "无法在资源管理器中定位该路径";
    }
    try {
      await navigator.clipboard.writeText(path);
      showPathToast(`${reason}（路径已复制）`);
    } catch {
      showPathToast(reason);
    }
  }

  async function handleMessagesClick(event: MouseEvent<HTMLDivElement>) {
    const entry = localPathEntryFromEventTarget(event.target);
    const path = entry?.dataset.path;
    if (!path) return;
    await revealLocalPath(path);
  }

  // 入口带 role="button" tabindex="0"，键盘激活必须与点击等价；Space 需
  // preventDefault 避免滚动消息区。
  function handleMessagesKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const entry = localPathEntryFromEventTarget(event.target);
    const path = entry?.dataset.path;
    if (!path) return;
    event.preventDefault();
    void revealLocalPath(path);
  }

  useLayoutEffect(() => {
    if (!isNearBottomRef.current) {
      setShowNewMessageHint(true);
      return;
    }
    scrollMessagesToBottom(messagesRef.current);
    const frame = window.requestAnimationFrame(() => {
      if (isNearBottomRef.current) scrollMessagesToBottom(messagesRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey]);

  useLayoutEffect(() => {
    if (activeView !== "conversation") return;
    isNearBottomRef.current = true;
    setIsNearBottom(true);
    setShowNewMessageHint(false);
    scrollMessagesToBottom(messagesRef.current);
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom(messagesRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, state.conversation.id]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 权威拦截：附件上传未完成时不允许发送（同步计数，不依赖渲染时序）。
    if (attachmentUploadLifecycleRef.current.getUploadingCount() > 0) {
      setAttachmentToast("附件还在上传中，请稍候再发送");
      window.setTimeout(() => setAttachmentToast(null), 3000);
      return;
    }
    const trimmed = content.trim();
    if (!trimmed || isSending || isSwitchingInteractionMode) {
      return;
    }

    setIsSending(true);
    // 发送链路绑定上下文快照（PR #147 M1）：目标经 query 参数随请求发送
    // （#155 页面上下文契约），服务端全程使用它归属本条消息；请求在途
    // 期间切换页面时，业务结算仍按发起时的会话完成，但响应到达后不得
    // 清空或污染新页面的输入区、附件状态与槽位。
    const lifecycle = attachmentUploadLifecycleRef.current;
    const sendContext = lifecycle.captureContext({
      workspaceId: state.workspace.id,
      conversationId: state.conversation.id,
    });
    const requestedContext = currentPageContext();
    if (!draftMessageIdRef.current || draftMessageIdRef.current.content !== trimmed) {
      draftMessageIdRef.current = { id: crypto.randomUUID(), content: trimmed };
    }
    try {
      const body: { content: string; approvalMode: ApprovalMode; clientMessageId: string; draftAttachments?: Array<{ id: string; mimeType: string; filename: string; size: number }> } = {
        content: trimmed,
        approvalMode,
        clientMessageId: draftMessageIdRef.current.id,
      };
      if (pendingAttachments.length > 0) {
        body.draftAttachments = pendingAttachments.map((a) => ({
          id: a.id,
          mimeType: a.mimeType,
          filename: a.filename,
          size: a.size,
        }));
      }
      const response = await fetch(withPageContext("/api/messages", requestedContext), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? `Message request failed: ${response.status}`);
      }

      const sent = await response.json() as { conversationId?: string };
      const sentConversationId = typeof sent.conversationId === "string" ? sent.conversationId : "";
      const pageContext = readPageContext(window.location.search);
      const stillOnSamePage = pageContext.workspaceId === requestedContext.workspaceId
        && (!pageContext.conversationId || pageContext.conversationId === requestedContext.conversationId);
      // 无会话页面发送时服务端会顺带建会话，客户端必须采用这个 id：
      // 否则事件 conversationId 与 state.conversation.id 不匹配而被 applyEvent 丢弃，
      // 首条消息及其回复都不可见，且之后每条消息都会再新建一个会话。
      if (sentConversationId && sentConversationId !== requestedContext.conversationId && stillOnSamePage) {
        const nextContext = { workspaceId: requestedContext.workspaceId, conversationId: sentConversationId };
        // 先同步地址栏：refreshState 校验地址栏与请求上下文是否一致，
        // 请求晚于 URL 更新会被当成过期响应丢弃。
        window.history.replaceState(null, "", `${window.location.pathname}${pageContextQuery(nextContext)}${window.location.hash}`);
        setState((current) => ({ ...current, conversation: { ...current.conversation, id: sentConversationId } }));
        refreshConversations();
        // 首条消息的 created 事件可能在会话 id 落地前送达并被丢弃，补一次全量拉取兜底。
        refreshState(nextContext);
      }

      // 仅当仍在发起发送的上下文中才清空输入区；过期响应跳过全部 UI 结算。
      if (!lifecycle.isStale(sendContext)) {
        draftMessageIdRef.current = null;
        setContent("");
        setPendingAttachments([]);
        lifecycle.clearSlots(sendContext);
        isNearBottomRef.current = true;
        setIsNearBottom(true);
        setShowNewMessageHint(false);
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    } catch (error) {
      // 过期上下文的失败提示不再注入当前会话的消息列表。
      if (!lifecycle.isStale(sendContext)) {
        // 附件草稿保留在输入区，修正后可直接重发。
        const detail = error instanceof Error && error.message && !error.message.startsWith("Message request failed")
          ? error.message
          : null;
        setState((current) => ({
          ...current,
          messages: [...current.messages, createLocalSystemMessage(detail ? `发送失败：${detail}` : "发送失败，请检查本地服务是否正在运行。")],
        }));
      }
    } finally {
      setIsSending(false);
    }
  }

  async function selectInteractionMode(mode: InteractionMode) {
    setShowInteractionModeMenu(false);
    if (isSwitchingInteractionMode || mode === interactionMode) return;
    setIsSwitchingInteractionMode(true);
    const label = interactionModeLabel(mode);
    const targetWorkspaceId = state.workspace.id;
    try {
      // 复杂协作需要监工运行时：优先沿用会话已配置的运行时，否则按可用性选择
      const runtime = mode === "supervised"
        ? state.conversation.supervisorConfig?.runtime ?? preferredSupervisionRuntime(state.runtimeAvailability)
        : undefined;

      // 首次对话还没有会话：先创建一个会话，再切换模式，保证菜单在首条消息前即可使用
      let conversationId = state.conversation.id;
      if (!conversationId) {
        if (!targetWorkspaceId) throw new Error("请先选择或创建工作区。");
        const createResponse = await fetch(withPageContext("/api/conversations", { workspaceId: targetWorkspaceId, conversationId: "" }), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const created = await createResponse.json() as { id?: string; message?: string };
        if (!createResponse.ok || !created.id) throw new Error(created.message ?? "创建会话失败。");
        if (readPageContext(window.location.search).workspaceId !== targetWorkspaceId) return;
        conversationId = created.id;
        window.history.pushState(null, "", `${window.location.pathname}${pageContextQuery({ workspaceId: targetWorkspaceId, conversationId })}${window.location.hash}`);
        refreshConversations();
      }

      const targetContext = { workspaceId: targetWorkspaceId, conversationId };
      const currentPage = readPageContext(window.location.search);
      if (currentPage.workspaceId !== targetContext.workspaceId
        || (currentPage.conversationId && currentPage.conversationId !== targetContext.conversationId)) return;
      const response = await fetch(withPageContext(`/api/conversations/${conversationId}/interaction-mode`, targetContext), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runtime ? { mode, runtime } : { mode }),
      });
      const body = await response.json() as { conversation?: ConversationInfo; message?: string };
      if (!response.ok || !body.conversation) throw new Error(body.message ?? `${label}切换失败`);
      const pageContext = readPageContext(window.location.search);
      if (pageContext.workspaceId !== targetContext.workspaceId || pageContext.conversationId !== targetContext.conversationId) return;
      setState((current) => ({ ...current, conversation: body.conversation! }));
    } catch (error) {
      setState((current) => ({ ...current, messages: [...current.messages, createLocalSystemMessage(error instanceof Error ? error.message : `${label}切换失败`)] }));
    } finally {
      setIsSwitchingInteractionMode(false);
    }
  }

  async function resolvePermission(requestId: string, decision: PermissionDecision) {
    if (resolvingPermissionIds.includes(requestId)) return;
    setResolvingPermissionIds((current) => [...current, requestId]);
    try {
      const response = await fetch(withPageContext("/api/permissions/resolve", currentPageContext()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, decision, ...currentPageContext() }),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Permission request failed: ${response.status}`);
      }
      if (response.status === 404) {
        setState((current) => ({
          ...current,
          pendingPermissions: current.pendingPermissions.filter((permission) => permission.id !== requestId),
        }));
      }
    } catch {
      setState((current) => ({
        ...current,
        messages: [...current.messages, createLocalSystemMessage("审批失败，请检查本地服务是否正在运行。")],
      }));
    } finally {
      setResolvingPermissionIds((current) => current.filter((id) => id !== requestId));
    }
  }

  async function resolveElicitation(requestId: string, response: ElicitationResponse) {
    if (resolvingElicitationIds.includes(requestId)) return;
    setResolvingElicitationIds((current) => [...current, requestId]);
    try {
      const httpResponse = await fetch(withPageContext("/api/elicitations/resolve", currentPageContext()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, ...response, ...currentPageContext() }),
      });
      if (!httpResponse.ok && httpResponse.status !== 404) {
        throw new Error(`Elicitation request failed: ${httpResponse.status}`);
      }
      if (httpResponse.status === 404) {
        setState((current) => ({
          ...current,
          pendingElicitations: current.pendingElicitations.filter((elicitation) => elicitation.id !== requestId),
        }));
      }
    } catch {
      setState((current) => ({
        ...current,
        messages: [...current.messages, createLocalSystemMessage("提交输入失败，请检查本地服务是否正在运行。")],
      }));
    } finally {
      setResolvingElicitationIds((current) => current.filter((id) => id !== requestId));
    }
  }

  /** 统一附件上传入口：文件选择、文件粘贴、图片粘贴与文本转附件都走这里。 */
  async function uploadAttachmentFiles(files: File[]) {
    if (files.length === 0) return;

    const maxFiles = ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE;
    const lifecycle = attachmentUploadLifecycleRef.current;
    // 以同步计数的“已占用槽位（含上传中）”判断上限：并发批次合计不会超过 5 个。
    if (lifecycle.getSlotCount() + files.length > maxFiles) {
      setAttachmentToast(`最多只能添加 ${maxFiles} 个附件`);
      window.setTimeout(() => setAttachmentToast(null), 3000);
      return;
    }
    // 每批上传绑定发起时的工作区/会话快照；请求显式携带目标 ID，服务端
    // 不再依赖全局 active 指针（PR #147 M1：上传中切换会话不得错投）。
    const uploadContext = lifecycle.beginUpload({
      workspaceId: state.workspace.id,
      conversationId: state.conversation.id,
    }, files.length);
    setUploadingAttachments(lifecycle.getUploadingCount());

    for (const file of files) {
      // 上下文已过期（切换了工作区/会话）：停止上传剩余文件。其槽位随
      // resetContext 清零消失，不再释放（释放会污染新会话的计数）。
      if (lifecycle.isStale(uploadContext)) {
        break;
      }
      const base64 = await readFileAsBase64(file);
      if (!base64) {
        lifecycle.releaseSlots(uploadContext);
        continue;
      }
      try {
        // 目标经 query 参数随请求发送（#155 页面上下文契约）：上传进行中
        // 切换会话时，文件仍保存到发起上传的会话目录，不会错投到新会话。
        const response = await fetch(withPageContext("/api/attachments/drafts", uploadContext), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: base64,
            mimeType: file.type,
            // 剪贴板图片可能没有文件名：回退到固定名，保证服务端可校验扩展名。
            filename: file.name || (file.type.startsWith("image/") ? "pasted-image.png" : ""),
          }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          setAttachmentToast((err as { message?: string }).message ?? "附件上传失败");
          window.setTimeout(() => setAttachmentToast(null), 3000);
          lifecycle.releaseSlots(uploadContext);
          continue;
        }
        const result = await response.json();
        if (!(result.ok && result.attachment)) {
          lifecycle.releaseSlots(uploadContext);
          continue;
        }
        if (lifecycle.isStale(uploadContext)) {
          // 过期结果：尽力删除已生成的草稿，绝不回写当前输入区；槽位同样
          // 不再释放（同上），避免递减新会话的占用。
          void fetch(
            `/api/attachments/drafts/${uploadContext.workspaceId}/${uploadContext.conversationId}/${result.attachment.id}`,
            { method: "DELETE" },
          ).catch(() => { /* best effort */ });
          continue;
        }
        setPendingAttachments((prev) => [...prev, result.attachment as DraftAttachmentInfo]);
      } catch {
        setAttachmentToast("附件上传失败");
        window.setTimeout(() => setAttachmentToast(null), 3000);
        lifecycle.releaseSlots(uploadContext);
      }
    }

    // 批次结束释放上传计数；过期回调不触碰新会话的计数与渲染态。
    if (lifecycle.finishUpload(uploadContext)) {
      setUploadingAttachments(lifecycle.getUploadingCount());
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    // 文件（含图片）：优先 files，其次 items 中的 file 条目。
    const pastedFiles: File[] = [];
    if (clipboard.files?.length) {
      for (const file of Array.from(clipboard.files)) pastedFiles.push(file);
    } else {
      const items = clipboard.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item?.kind === "file") {
            const file = item.getAsFile();
            if (file) pastedFiles.push(file);
          }
        }
      }
    }

    if (pastedFiles.length > 0) {
      // 浏览器能否暴露 Finder/Explorer 复制的文件取决于平台；拿不到时用户仍可用“添加附件”。
      event.preventDefault();
      void uploadAttachmentFiles(pastedFiles);
      return;
    }

    // 部分浏览器把复制的文件仅暴露为 file:// 文本：无法读取内容，引导改用文件选择。
    if (looksLikeFileUrlPaste(clipboard.getData("text/plain"))) {
      event.preventDefault();
      setAttachmentToast("当前浏览器无法读取复制文件的内容，请使用“添加附件”按钮选择文件。");
      window.setTimeout(() => setAttachmentToast(null), 3000);
      return;
    }
  }

  async function removePendingAttachment(id: string) {
    const lifecycle = attachmentUploadLifecycleRef.current;
    // 删除请求绑定发起时的上下文快照：在途期间切换会话后，槽位释放
    // 对过期上下文直接忽略，不递减新会话的占用（PR #147 M1）。
    const removeContext = lifecycle.captureContext({
      workspaceId: state.workspace.id,
      conversationId: state.conversation.id,
    });
    const hadAttachment = pendingAttachments.some((a) => a.id === id);
    try {
      await fetch(`/api/attachments/drafts/${removeContext.workspaceId}/${removeContext.conversationId}/${id}?workspaceId=${encodeURIComponent(removeContext.workspaceId)}&conversationId=${encodeURIComponent(removeContext.conversationId)}`, {
        method: "DELETE",
      });
    } catch { /* best effort */ }
    if (hadAttachment) {
      lifecycle.removeSlot(removeContext);
    }
    // 过期回调不得触碰当前输入区 state（即使 UUID 过滤通常为 no-op）。
    if (!lifecycle.isStale(removeContext)) {
      setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
    }
  }

  async function interruptChain() {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      const response = await fetch(withPageContext("/api/conversation/interrupt", currentPageContext()), { method: "POST" });
      if (!response.ok) {
        throw new Error(`Interrupt request failed: ${response.status}`);
      }
      const data = await response.json();
      if ((data.cancelledQueuedRunIds?.length ?? 0) > 0 || (data.cancellingRunningRunIds?.length ?? 0) > 0) {
        setInterruptToast("正在停止所有任务");
        window.setTimeout(() => setInterruptToast(null), 3000);
      }
    } catch {
      setState((current) => ({
        ...current,
        messages: [...current.messages, createLocalSystemMessage("打断操作失败，请检查本地服务是否正在运行。")],
      }));
    } finally {
      setIsInterrupting(false);
    }
  }

  async function loadOlderMessages() {
    const cursor = state.messageHistory.olderCursor;
    if (!cursor || isLoadingOlderMessages) return;
    const requestContext = {
      workspaceId: state.workspace.id,
      conversationId: state.conversation.id,
    };

    setIsLoadingOlderMessages(true);
    try {
      const response = await fetch(withPageContext(`/api/messages?before=${encodeURIComponent(cursor)}&limit=50`, requestContext));
      if (!response.ok) {
        throw new Error(`Messages request failed: ${response.status}`);
      }
      const page = (await response.json()) as MessagePage;
      setState((current) => mergeOlderMessagesPage(current, requestContext, page));
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }

  function chooseAgent(agentId: AgentId) {
    const agentName = agentsById.get(agentId)?.label ?? agentId;
    setSelectedAgent(agentId);
    setContent((current) => {
      if (!current.trim() || /^@[^\s@:：]+:\s*$/.test(current.trim())) {
        return `@${agentName}: `;
      }
      return current;
    });
    const nextCursorIndex = agentName.length + 3;
    setCursorIndex(nextCursorIndex);
    window.setTimeout(() => {
      inputRef.current?.focus();
      if (!content.trim() || /^@[^\s@:：]+:\s*$/.test(content.trim())) {
        inputRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
      }
    }, 0);
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === state.workspace.id) return;
    const nextContext = { workspaceId, conversationId: "" };
    window.history.pushState(null, "", `${window.location.pathname}${pageContextQuery(nextContext)}${window.location.hash}`);
    const requestVersion = ++stateRequestVersionRef.current;
    const response = await fetch(withPageContext("/api/state", nextContext));
    if (!response.ok) return;
    refreshWorkspaces();
    refreshConversations();
    const nextState = await response.json() as AppState;
    const pageContext = readPageContext(window.location.search);
    if (requestVersion !== stateRequestVersionRef.current
      || pageContext.workspaceId !== nextContext.workspaceId
      || pageContext.conversationId !== nextContext.conversationId) return;
    setState(normalizeState(nextState));
  }

  function handleWorkspaceClick(workspaceId: string) {
    setExpandedWorkspaceIds((ids) => {
      const next = new Set(ids);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
    // Eagerly load conversations for this workspace
    if (!conversationsByWorkspace[workspaceId]) {
      fetch(`/api/workspaces/${workspaceId}/conversations`)
        .then((r) => r.json())
        .then((convs: Conversation[]) => {
          setConversationsByWorkspace((prev) => ({ ...prev, [workspaceId]: convs }));
        })
        .catch(() => {});
    }
  }

  async function createWorkspaceFromDirectoryPicker() {
    setIsPickingDirectory(true);
    try {
      const pickResponse = await fetch("/api/workspaces/pick-directory", { method: "POST" });
      if (!pickResponse.ok) return;
      const result = (await pickResponse.json()) as { path?: string };
      const selectedPath = result.path?.trim();
      if (!selectedPath) return;

      const action = getWorkspaceCreationAction(workspacePresets);
      if (action.kind === "create") {
        await createWorkspace(selectedPath);
      } else {
        setPendingWorkspacePath(selectedPath);
      }
    } finally {
      setIsPickingDirectory(false);
    }
  }

  async function confirmWorkspaceCreation(presetId: string) {
    const selectedPath = pendingWorkspacePath;
    if (!selectedPath) return;
    await createWorkspace(selectedPath, presetId);
  }

  async function createWorkspace(selectedPath: string, presetId?: string) {
    try {
      const createResponse = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath, presetId }),
      });
      if (!createResponse.ok) {
        let message = `创建工作区失败 (${createResponse.status})`;
        try {
          const body = await createResponse.json();
          if (body?.message) message = `创建工作区失败：${body.message}`;
        } catch { /* ignore parse error, fall back to status */ }
        window.alert(message);
        return;
      }
      const workspace = (await createResponse.json()) as Workspace;
      setPendingWorkspacePath(null);
      if (workspace.id) {
        await switchWorkspace(workspace.id);
      }
      refreshWorkspaces();
    } catch {
      window.alert("创建工作区失败：无法连接本地服务。");
    }
  }

  async function renameWorkspace(workspaceId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingWorkspaceId(null);
      setEditingWorkspaceName("");
      return;
    }
    const response = await fetch(`/api/workspaces/${workspaceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!response.ok) return;
    setEditingWorkspaceId(null);
    setEditingWorkspaceName("");
    refreshWorkspaces();
    refreshState();
  }

  async function deleteWorkspace(workspace: Workspace) {
    if (!confirm(`Delete workspace "${workspace.name}"?`)) return;
    const response = await fetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
    if (!response.ok) return;
    setOpenWorkspaceMenuId(null);
    setExpandedWorkspaceIds((ids) => {
      const next = new Set(ids);
      next.delete(workspace.id);
      return next;
    });
    const isCurrentPage = readPageContext(window.location.search).workspaceId === workspace.id;
    refreshWorkspaces();
    if (!isCurrentPage) {
      refreshConversations();
      return;
    }

    // The deleted page context is no longer valid. Let the server choose the
    // next available workspace, then publish that choice in this tab's URL.
    window.history.pushState(null, "", `${window.location.pathname}${window.location.hash}`);
    const requestVersion = ++stateRequestVersionRef.current;
    const nextStateResponse = await fetch("/api/state");
    if (!nextStateResponse.ok || requestVersion !== stateRequestVersionRef.current) return;
    const nextState = normalizeState(await nextStateResponse.json() as AppState);
    if (nextState.workspace.id) {
      window.history.replaceState(null, "", `${window.location.pathname}${pageContextQuery({ workspaceId: nextState.workspace.id, conversationId: nextState.conversation.id })}${window.location.hash}`);
    }
    setState(nextState);
    refreshConversations();
  }

  async function switchConversation(conversationId: string, targetWorkspaceId?: string) {
    // Always return to the conversation view when a conversation is clicked,
    // even if it is already the active one (e.g. returning from 协作洞察).
    // The guard below only skips the redundant /switch request.
    setActiveView("conversation");
    const workspaceId = targetWorkspaceId || state.workspace.id;
    if (conversationId === state.conversation.id) {
      if (workspaceId === state.workspace.id) return;
    }
    const nextContext = { workspaceId, conversationId };
    window.history.pushState(null, "", `${window.location.pathname}${pageContextQuery(nextContext)}${window.location.hash}`);
    const requestVersion = ++stateRequestVersionRef.current;
    const response = await fetch(withPageContext("/api/state", nextContext));
    if (!response.ok) return;
    refreshConversations();
    const nextState = await response.json() as AppState;
    const pageContext = readPageContext(window.location.search);
    if (requestVersion !== stateRequestVersionRef.current
      || pageContext.workspaceId !== nextContext.workspaceId
      || pageContext.conversationId !== nextContext.conversationId) return;
    setState(normalizeState(nextState));
  }

  async function createConversation(workspaceId: string) {
    const response = await fetch(withPageContext("/api/conversations", { workspaceId, conversationId: "" }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) return;
    setActiveView("conversation");
    // Expand the workspace so user sees the new conversation
    setExpandedWorkspaceIds((ids) => {
      const next = new Set(ids);
      next.add(workspaceId);
      return next;
    });
    const conversation = await response.json() as Conversation;
    const nextContext = { workspaceId, conversationId: conversation.id };
    window.history.pushState(null, "", `${window.location.pathname}${pageContextQuery(nextContext)}${window.location.hash}`);
    refreshConversations();
    const requestVersion = ++stateRequestVersionRef.current;
    const stateResponse = await fetch(withPageContext("/api/state", nextContext));
    if (!stateResponse.ok || requestVersion !== stateRequestVersionRef.current) return;
    const pageContext = readPageContext(window.location.search);
    if (pageContext.workspaceId !== nextContext.workspaceId || pageContext.conversationId !== nextContext.conversationId) return;
    setState(normalizeState(await stateResponse.json() as AppState));
  }

  async function renameConversation(conversationId: string, name: string, workspaceId?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingConversationId(null);
      setEditingConversationName("");
      return;
    }
    const response = await fetch(withPageContext(`/api/conversations/${conversationId}`, { workspaceId: workspaceId || state.workspace.id, conversationId }), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!response.ok) return;
    setEditingConversationId(null);
    setEditingConversationName("");
    refreshConversations();
    if ((workspaceId || state.workspace.id) === state.workspace.id && conversationId === state.conversation.id) refreshState();
  }

  async function deleteConversation(conversation: Conversation) {
    if (!confirm(`Delete conversation "${conversation.name}"?`)) return;
    const response = await fetch(`/api/conversations/${conversation.id}?workspaceId=${conversation.workspaceId}`, { method: "DELETE" });
    if (response.ok) {
      setOpenConversationMenuId(null);
      refreshConversations();
      if (conversation.workspaceId === state.workspace.id && conversation.id === state.conversation.id) {
        const response = await fetch(`/api/workspaces/${conversation.workspaceId}/conversations`);
        const conversations = response.ok ? await response.json() as Conversation[] : [];
        const nextConversation = conversations[0];
        const nextContext = {
          workspaceId: conversation.workspaceId,
          conversationId: nextConversation?.id ?? "",
        };
        window.history.pushState(null, "", `${window.location.pathname}${pageContextQuery(nextContext)}${window.location.hash}`);
        const requestVersion = ++stateRequestVersionRef.current;
        const stateResponse = await fetch(withPageContext("/api/state", nextContext));
        if (stateResponse.ok && requestVersion === stateRequestVersionRef.current) {
          const pageContext = readPageContext(window.location.search);
          if (pageContext.workspaceId === nextContext.workspaceId && pageContext.conversationId === nextContext.conversationId) {
            setState(normalizeState(await stateResponse.json() as AppState));
          }
        }
      }
    }
  }

  function updateCursorFromInput() {
    setCursorIndex(inputRef.current?.selectionStart ?? content.length);
  }

  function chooseMention(agentId: AgentId) {
    if (!mentionDraft) {
      return;
    }

    const agentName = agentsById.get(agentId)?.label ?? agentId;
    const nextContent = `${content.slice(0, mentionDraft.start)}@${agentName}: ${content.slice(mentionDraft.end)}`;
    const nextCursorIndex = mentionDraft.start + agentName.length + 3;
    setSelectedAgent(agentId);
    setContent(nextContent);
    setCursorIndex(nextCursorIndex);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
    }, 0);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isImeComposition(event)) {
      return;
    }

    if (mentionCandidates.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedMentionIndex((index) => (index + 1) % mentionCandidates.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedMentionIndex((index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length);
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      chooseMention(mentionCandidates[selectedMentionIndex] ?? mentionCandidates[0]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setInputFocused(false);
    }
  }

  return (
    <main
      className={`shell ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}
      style={{
        gridTemplateColumns: sidebarCollapsed ? "0 minmax(0, 1fr)" : `${sidebarWidth}px minmax(0, 1fr)`,
        "--sidebar-resize-left": `${sidebarWidth}px`,
      } as CSSProperties}
    >
      <aside className="sidebar" aria-label="工作区导航" aria-hidden={sidebarCollapsed}>
        <div className="sidebarTop">
          <div className="brandBlock">
            <div className="brandMark"><img src="/assets/orbit-mark.png" alt="" />Orbit</div>
            <div className={`connection ${connectionState}`}>{connectionLabel(connectionState)}</div>
            <Tooltip content="隐藏侧边栏" placement="right">
              <Button className="sidebarCollapseBtn" variant="text" shape="square" icon={<ChevronLeftIcon />} onClick={() => setSidebarCollapsed(true)} />
            </Tooltip>
          </div>
        </div>

        <section className="navSection workspaceStack" aria-label="当前工作区和会话">
          <div className="navSectionHeader">
            <span>工作区</span>
            <Button size="small" variant="text" shape="square" icon={<AddIcon />} onClick={createWorkspaceFromDirectoryPicker} disabled={isPickingDirectory} title="新建工作区" />
          </div>
          <div className="workspaceTree">
            {workspaces.length === 0 ? (
              <div className="emptyNavHint">还没有工作区</div>
            ) : (
              workspaces.map((ws) => {
                const isActiveWorkspace = ws.id === state.workspace.id;
                const isWorkspaceConversationOpen = expandedWorkspaceIds.has(ws.id);
                return (
                  <div className="workspaceGroup" key={ws.id}>
                    <div className={`workspaceTreeRow ${isActiveWorkspace ? "active" : ""}`}>
                      {editingWorkspaceId === ws.id ? (
                        <form
                          className="rowRenameForm"
                          onSubmit={(event) => {
                            event.preventDefault();
                            renameWorkspace(ws.id, editingWorkspaceName);
                          }}
                        >
                          <input
                            value={editingWorkspaceName}
                            onChange={(event) => setEditingWorkspaceName(event.target.value)}
                            onBlur={() => renameWorkspace(ws.id, editingWorkspaceName)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setEditingWorkspaceId(null);
                                setEditingWorkspaceName("");
                              }
                            }}
                            autoFocus
                          />
                        </form>
                      ) : (
                        <button className="workspaceNameButton" type="button" onClick={() => handleWorkspaceClick(ws.id)} title={ws.path}>
                          <FolderIcon className="navIcon" />
                          <span>{ws.name}</span>
                        </button>
                      )}
                      <div className="rowMenuWrap">
                        <button
                          className="rowIconButton persistent"
                          type="button"
                          onClick={() => {
                            setOpenConversationMenuId(null);
                            setOpenWorkspaceMenuId((id) => (id === ws.id ? null : ws.id));
                          }}
                          title="工作区操作"
                        >
                          ...
                        </button>
                        {openWorkspaceMenuId === ws.id ? (
                          <div className="rowActionMenu">
                            <button
                              type="button"
                              onClick={() => {
                                setOpenWorkspaceMenuId(null);
                                if (ws.id !== state.workspace.id) {
                                  switchWorkspace(ws.id);
                                }
                                setShowWorkspaceConfig(true);
                              }}
                            >
                              工作区配置
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenWorkspaceMenuId(null);
                                setEditingWorkspaceId(ws.id);
                                setEditingWorkspaceName(ws.name);
                              }}
                            >
                              重命名工作区
                            </button>
                            <button type="button" onClick={() => deleteWorkspace(ws)}>删除工作区</button>
                          </div>
                        ) : null}
                      </div>
                      {isWorkspaceConversationOpen ? (
                        <button className="rowIconButton persistent" type="button" onClick={() => createConversation(ws.id)} title="新建会话">
                          <EditIcon className="navIcon" />
                        </button>
                      ) : null}
                    </div>
                    {isWorkspaceConversationOpen ? (
                      <div className="navList conversationList">
                        {(conversationsByWorkspace[ws.id] ?? []).map((conv) => {
                          const runningLabel = getConversationRunningLabel(state.runningSummaries, state.agents, ws.id, conv.id);
                          return (
                            <div className={`conversationRow ${conv.id === state.conversation.id ? "active" : ""}`} key={conv.id}>
                            {editingConversationId === conv.id ? (
                              <form
                                className="rowRenameForm"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  renameConversation(conv.id, editingConversationName, ws.id);
                                }}
                              >
                                <input
                                  value={editingConversationName}
                                  onChange={(event) => setEditingConversationName(event.target.value)}
                                  onBlur={() => renameConversation(conv.id, editingConversationName, ws.id)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                      setEditingConversationId(null);
                                      setEditingConversationName("");
                                    }
                                  }}
                                  autoFocus
                                />
                              </form>
                            ) : (
                              <div className="conversationRowName">
                                <button type="button" onClick={() => switchConversation(conv.id, ws.id)} title={conv.name}>
                                  <span>{conv.name}</span>
                                </button>
                                {runningLabel ? (
                                  <span className="conversationRunningDot" title={runningLabel} aria-label={runningLabel} role="img" />
                                ) : null}
                              </div>
                            )}
                            <div className="rowMenuWrap">
                              <button
                                className="rowIconButton conversationMenuButton"
                                type="button"
                                onClick={() => {
                                  setOpenWorkspaceMenuId(null);
                                  setOpenConversationMenuId((id) => (id === conv.id ? null : conv.id));
                                }}
                                title="会话操作"
                              >
                                ...
                              </button>
                              {openConversationMenuId === conv.id ? (
                                <div className="rowActionMenu">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenConversationMenuId(null);
                                      setEditingConversationId(conv.id);
                                      setEditingConversationName(conv.name);
                                    }}
                                  >
                                    重命名会话
                                  </button>
                                  <button type="button" onClick={() => deleteConversation(conv)}>删除会话</button>
                                </div>
                              ) : null}
                            </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="navSection compactAgents" aria-label="数字员工团队">
          <div className="navSectionHeader">
            <span><UsergroupIcon />数字员工团队</span>
            <Button size="small" variant="text" shape="square" icon={<AddIcon />} onClick={() => setShowAgentManager(true)} disabled={!hasWorkspace} title="添加或启用数字员工" />
          </div>
          <nav className="agentList" aria-label="选择数字员工">
            {agentIds.length === 0 ? (
              <div className="emptyAgentsHint">
                <strong>还没有启用数字员工</strong>
                <span>点击右上角 +，启用默认模板或添加自定义数字员工。</span>
              </div>
            ) : (
              agentIds.map((agentId) => (
                <AgentButton
                  key={agentId}
                  agent={agentsById.get(agentId) ?? { id: agentId, label: agentId, runtime: "claude-code", status: "idle" }}
                  selected={selectedAgent === agentId}
                  showLiveStatus={activeView === "conversation"}
                  onClick={() => chooseAgent(agentId)}
                  onConfig={() => { setFocusedAgentId(agentId); setShowAgentManager(true); }}
                />
              ))
            )}
          </nav>
        </section>

        {/* 底部设置区 */}
        <div className="sidebarBottom">
          <button
            type="button"
            className={`sidebarUtilityBtn ${activeView === "analysis" ? "active" : ""}`}
            onClick={() => setActiveView("analysis")}
            disabled={!hasWorkspace}
            title="可观测"
          >
            <ChartIcon />
            <span>可观测</span>
          </button>
          <button
            type="button"
            className="sidebarSettingsBtn"
            onClick={() => setShowSettings(true)}
            title="设置"
          >
            <SettingIcon />
            <span>设置</span>
          </button>
        </div>
      </aside>
      <button
        className="sidebarRevealBtn"
        type="button"
        onClick={() => setSidebarCollapsed(false)}
        title="显示侧边栏"
        aria-label="显示侧边栏"
      >
        <ChevronRightIcon />
      </button>
      <div
        className="sidebarResizeHandle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧边栏宽度"
        onPointerDown={(event) => {
          if (sidebarCollapsed) return;
          event.preventDefault();
          setIsResizingSidebar(true);
        }}
      />

      {activeView === "analysis" ? (
        <WorkAnalysisPanel
          workspaceId={state.workspace.id}
          onOpenConversation={(conversationId) => { void switchConversation(conversationId); }}
        />
      ) : (
      <section className="conversation" aria-label="Chat conversation">
        <header className="conversationHeader">
          <div className="conversationHeaderLeft">
            <div className="conversationBreadcrumb"><span>{state.workspace.name || "工作区"}</span><ChevronRightIcon /><span>会话</span><ChevronRightIcon /></div>
            <h1>{state.conversation.name || (hasWorkspace ? "新会话" : "未选择工作区")}</h1>
            {state.workspace.path ? <p className="workspacePath" title={state.workspace.path}>{state.workspace.path}</p> : null}
          </div>
          <div className="conversationHeaderRight">
            <Avatar.Group size="28px" max={4}>
              {state.agents.map((agent) => <Avatar key={agent.id} style={{ backgroundColor: agentColor(agent.id) }}>{agent.label.slice(0, 1)}</Avatar>)}
            </Avatar.Group>
            <span className="headerMeta">{state.agents.length} 人在线</span>
            <Button variant="text" shape="square" icon={<MoreIcon />} aria-label="更多操作" />
          </div>
        </header>

        <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-label="消息列表" onScroll={handleMessagesScroll} onClick={(event) => { void handleMessagesClick(event); }} onKeyDown={handleMessagesKeyDown}>
          {state.messageHistory.hasOlderMessages ? (
            <button
              className="loadOlderMessagesBtn"
              type="button"
              onClick={loadOlderMessages}
              disabled={isLoadingOlderMessages}
            >
              {isLoadingOlderMessages ? "加载中..." : "加载更早的消息"}
            </button>
          ) : null}
          {visibleMessages.length === 0 ? (
            <div className="emptyState">
              <div className="emptyOrbital" aria-hidden="true">
                <svg viewBox="0 0 120 120" width="120" height="120">
                  <circle className="orbitRing orbitRing1" cx="60" cy="60" r="48" fill="none" stroke="var(--border)" strokeWidth="1" />
                  <circle className="orbitRing orbitRing2" cx="60" cy="60" r="34" fill="none" stroke="var(--border-light)" strokeWidth="1" />
                  <circle className="orbitCore" cx="60" cy="60" r="8" fill="var(--accent)" opacity="0.2" />
                  <circle className="orbitDot orbitDot1" cx="60" cy="12" r="4" fill="var(--accent)" />
                  <circle className="orbitDot orbitDot2" cx="94" cy="60" r="3" fill="var(--secondary)" />
                  <circle className="orbitDot orbitDot3" cx="60" cy="94" r="3.5" fill="var(--success)" />
                </svg>
              </div>
              <p className="emptyTitle">{hasWorkspace ? "准备开始" : "先选择工作区"}</p>
              <ol className="emptySteps">
                {hasWorkspace ? (
                  <>
                    <li><strong>1</strong> 启用或添加数字员工</li>
                    <li><strong>2</strong> 使用 <code>@数字员工名称:</code> 输入任务</li>
                    <li><strong>3</strong> 首句话会成为会话名称</li>
                  </>
                ) : (
                  <>
                    <li><strong>1</strong> 点击工作区旁边的 <code>+</code></li>
                    <li><strong>2</strong> 选择本地项目目录</li>
                    <li><strong>3</strong> 开始输入第一条任务</li>
                  </>
                )}
              </ol>
            </div>
          ) : (
            visibleMessages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                agent={message.agentId ? agentsById.get(message.agentId) : undefined}
                parentMessage={message.parentMessageId ? messagesById.get(message.parentMessageId) : undefined}
                agentsById={agentsById}
              />
            ))
          )}
          <div ref={messagesEndRef} />
          {showNewMessageHint && (
            <button
              className="scrollToBottomHint"
              onClick={() => {
                scrollMessagesToBottom(messagesRef.current);
                setShowNewMessageHint(false);
                setIsNearBottom(true);
              }}
            >
              <ArrowDownIcon />
            </button>
          )}
        </div>

        {missingRuntimeAgents.length > 0 ? (
          <RuntimeSetupBanner
            agents={missingRuntimeAgents}
            isRefreshing={isRefreshingRuntimes}
            onRefresh={refreshRuntimeAvailability}
          />
        ) : null}
        {interruptToast ? <div className="interruptToast">{interruptToast}</div> : null}
        {attachmentToast ? <div className="attachmentToast">{attachmentToast}</div> : null}
        {pathToast ? <div className="attachmentToast pathToast">{pathToast}</div> : null}
        {state.pendingPermissions.length > 0 ? (
          <div className="permissionApprovalStack" aria-live="polite">
            {state.pendingPermissions.map((permission) => (
              <PermissionApprovalPanel
                key={permission.id}
                permission={permission}
                agentLabel={agentsById.get(permission.agentId)?.label ?? permission.agentId}
                resolving={resolvingPermissionIds.includes(permission.id)}
                onDecision={(decision) => resolvePermission(permission.id, decision)}
              />
            ))}
          </div>
        ) : null}
        {state.pendingElicitations.length > 0 ? (
          <div className="elicitationStack" aria-live="polite">
            {state.pendingElicitations.map((elicitation) => (
              <ElicitationPanel
                key={elicitation.id}
                elicitation={elicitation}
                agentLabel={agentsById.get(elicitation.agentId)?.label ?? elicitation.agentId}
                resolving={resolvingElicitationIds.includes(elicitation.id)}
                onResponse={(response) => resolveElicitation(elicitation.id, response)}
              />
            ))}
          </div>
        ) : null}
        <form className="composer" onSubmit={sendMessage}>
          <div className={`composerInputWrap${pendingAttachments.length > 0 ? " hasAttachments" : ""}`}>
            {pendingAttachments.length > 0 && (
              <div className="attachmentPreviewBar">
                {pendingAttachments.map((att) => (
                  <div key={att.id} className="attachmentPreviewItem">
                    {att.kind === "image" && att.previewUrl ? (
                      <>
                        <img
                          src={att.previewUrl}
                          alt={att.filename}
                          className="attachmentPreviewThumb"
                          onClick={() => setPreviewAttachment(att)}
                          title="点击预览"
                        />
                        <button
                          type="button"
                          className="attachmentPreviewRemove"
                          onClick={() => removePendingAttachment(att.id)}
                          title="移除图片"
                        >&times;</button>
                      </>
                    ) : (
                      <div className="attachmentFileChip" title={att.filename}>
                        <span className="attachmentFileChipName">{att.filename}</span>
                        <span className="attachmentFileChipMeta">{formatFileSize(att.size)}</span>
                        <button
                          type="button"
                          className="attachmentPreviewRemove"
                          onClick={() => removePendingAttachment(att.id)}
                          title="移除附件"
                          aria-label={`移除附件 ${att.filename}`}
                        >&times;</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              accept={attachmentAcceptAttribute()}
              className="attachmentFileInput"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void uploadAttachmentFiles(files);
              }}
            />
            <textarea
              ref={inputRef}
              value={content}
              rows={1}
              onPaste={handlePaste}
              onBlur={() => window.setTimeout(() => setInputFocused(false), 120)}
              onChange={(event) => {
                setContent(event.target.value);
                setCursorIndex(event.target.selectionStart ?? event.target.value.length);
                event.target.style.height = "auto";
                const maxRows = 6;
                const lineHeight = 22;
                event.target.style.height = `${Math.min(event.target.scrollHeight, lineHeight * maxRows)}px`;
              }}
              onClick={updateCursorFromInput}
              onFocus={(event) => {
                setInputFocused(true);
                setCursorIndex(event.target.selectionStart ?? event.target.value.length);
              }}
              onKeyDown={(event) => {
                if (isImeComposition(event)) {
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage(event as unknown as FormEvent<HTMLFormElement>);
                  return;
                }
                handleComposerKeyDown(event as unknown as KeyboardEvent<HTMLInputElement>);
              }}
              onKeyUp={updateCursorFromInput}
              placeholder={!hasWorkspace
                ? "先选择或创建工作区"
                : !hasEnabledAgent
                  ? "先添加或启用数字员工"
                  : interactionMode === "direct"
                    ? lastDirectAgentLabel
                      ? `继续与 ${lastDirectAgentLabel} 对话，或 @其他员工切换`
                      : "@一位数字员工开始对话"
                    : interactionMode === "supervised"
                      ? "输入目标，由监工协调数字员工"
                      : "@一位数字员工发起协作"}
              aria-label="Message to agent"
              disabled={!hasWorkspace || !hasEnabledAgent}
              spellCheck={false}
            />
            {mentionCandidates.length > 0 ? (
              <MentionMenu
                agentsById={agentsById}
                candidates={mentionCandidates}
                selectedIndex={selectedMentionIndex}
                onSelect={chooseMention}
              />
            ) : null}
            <div className="composerModeRow">
              <div className="attachmentControl">
                <button
                  type="button"
                  className="attachmentControlTrigger"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={!hasWorkspace || !hasEnabledAgent}
                  title="添加附件（图片、PDF、文本或代码文件）"
                  aria-label="添加附件"
                >
                  <AttachIcon className="attachmentControlIcon" />
                </button>
              </div>
              <div className="interactionModeControl">
                <button
                  type="button"
                  className={`interactionModeTrigger ${interactionMode !== "collaborative" ? "accented" : ""}`}
                  onClick={() => setShowInteractionModeMenu((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={showInteractionModeMenu}
                  title={interactionModeTooltip(interactionMode)}
                >
                  <UsergroupIcon className="interactionModeIcon" />
                  <span>{interactionModeLabel(interactionMode)}</span>
                  <span className="approvalModeChevron" aria-hidden="true">⌄</span>
                </button>
                {showInteractionModeMenu ? (
                  <div className="interactionModeMenu" role="menu" aria-label="会话协作模式">
                    {INTERACTION_MODE_META.map((meta) => (
                      <div className="interactionModeRow" key={meta.mode}>
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={interactionMode === meta.mode}
                          title={meta.tooltip}
                          onClick={() => { void selectInteractionMode(meta.mode); }}
                        >
                          <InteractionModeIcon mode={meta.mode} />
                          <span><strong>{meta.label}</strong><small>{meta.tooltip}</small></span>
                          {interactionMode === meta.mode ? <span className="approvalModeCheck" aria-hidden="true">✓</span> : null}
                        </button>
                        {/* 监工设置是独立入口而非嵌套按钮：复杂协作开启前后都能改。 */}
                        {meta.mode === "supervised" ? (
                          <button
                            type="button"
                            className="supervisorSettingsTrigger"
                            title="设置监工使用的运行时与模型"
                            onClick={() => {
                              setShowInteractionModeMenu(false);
                              setShowSupervisorSettings(true);
                            }}
                          >
                            监工设置
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="approvalModeControl">
                <button
                  type="button"
                  className={`approvalModeTrigger ${approvalMode === "full-access" ? "fullAccess" : ""}`}
                  onClick={() => setShowApprovalModeMenu((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={showApprovalModeMenu}
                  title="设置这条消息及后续协作的审批方式"
                >
                  <SecuredIcon className="approvalModeIcon" />
                  <span>{approvalMode === "full-access" ? "完全批准" : "向我审批"}</span>
                  <span className="approvalModeChevron" aria-hidden="true">⌄</span>
                </button>
                {showApprovalModeMenu ? (
                  <div className="approvalModeMenu" role="menu" aria-label="权限审批方式">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={approvalMode === "ask"}
                      onClick={() => { setApprovalMode("ask"); setShowApprovalModeMenu(false); }}
                    >
                      <ApprovalModeIcon mode="ask" />
                      <span><strong>向我审批</strong><small>敏感操作执行前暂停并询问</small></span>
                      {approvalMode === "ask" ? <span className="approvalModeCheck" aria-hidden="true">✓</span> : null}
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={approvalMode === "full-access"}
                      onClick={() => { setApprovalMode("full-access"); setShowApprovalModeMenu(false); }}
                    >
                      <ApprovalModeIcon mode="full-access" />
                      <span><strong>完全批准</strong><small>自动批准员工权限范围内的操作</small></span>
                      {approvalMode === "full-access" ? <span className="approvalModeCheck" aria-hidden="true">✓</span> : null}
                    </button>
                  </div>
                ) : null}
              </div>
            <div className="composerActions">
            {hasRunningOrQueued ? (
              <Button
                type="button"
                className="interruptBtn"
                onClick={interruptChain}
                disabled={isInterrupting || hasCancellingRun}
                title="停止所有任务"
                variant="outline"
                theme="danger"
                icon={<StopCircleIcon />}
              >
                {isInterrupting || hasCancellingRun ? <><span className="sendSpinner" aria-hidden="true" />正在停止…</> : "停止所有任务"}
              </Button>
            ) : null}
            <Button
              type="submit"
              theme="primary"
              icon={<SendIcon />}
              disabled={!hasWorkspace || !hasEnabledAgent || !content.trim() || isSending || isSwitchingInteractionMode || uploadingAttachments > 0}
              title={uploadingAttachments > 0 ? "附件上传中，完成后可发送" : undefined}
            >
              {isSending ? <span className="sendSpinner" aria-hidden="true" /> : uploadingAttachments > 0 ? "上传中…" : "发送"}
            </Button>
            </div>
          </div>
          </div>
        </form>
      </section>
      )}
      {showSettings ? (
        <SystemSettingsPanel
          onClose={() => setShowSettings(false)}
        />
      ) : null}
      {showWorkspaceConfig ? (
        <WorkspaceConfigPanel
          onClose={() => setShowWorkspaceConfig(false)}
          hasWorkspace={hasWorkspace}
          workspaceId={state.workspace.id}
          presets={workspacePresets}
        />
      ) : null}
      {pendingWorkspacePath ? (
        <div className="modalOverlay" onClick={() => setPendingWorkspacePath(null)}>
          <div className="modalPanel presetPickerPanel" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>选择数字员工团队</h2>
              <button type="button" onClick={() => setPendingWorkspacePath(null)}>&times;</button>
            </div>
            <div className="settingsBody">
              <span className="workspaceConfigHint">选择团队模板将预置对应的数字员工；选择空白则不预置，创建后可自行添加。</span>
              <div className="presetPickerList">
                {workspacePresets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    onClick={() => confirmWorkspaceCreation(preset.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showAgentManager ? (
        <AgentManagerPanel
          workspaceId={state.workspace.id}
          focusedAgentId={focusedAgentId}
          onClose={() => { setShowAgentManager(false); setFocusedAgentId(null); }}
          onSaved={() => { setShowAgentManager(false); setFocusedAgentId(null); window.location.reload(); }}
          runtimeAvailability={state.runtimeAvailability}
          isRefreshingRuntimes={isRefreshingRuntimes}
          onRefreshRuntimes={refreshRuntimeAvailability}
          modelStates={state.agentModelStates}
        />
      ) : null}
      {showSupervisorSettings ? (
        <SupervisorSettingsPanel
          workspaceId={state.workspace.id}
          conversationId={state.conversation.id}
          config={supervisorConfig}
          availability={state.runtimeAvailability}
          onClose={() => setShowSupervisorSettings(false)}
          onSave={saveSupervisorConfig}
        />
      ) : null}
      {previewAttachment ? (
        <div className="imagePreviewOverlay" onClick={() => setPreviewAttachment(null)}>
          <div className="imagePreviewModal" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="imagePreviewClose"
              onClick={() => setPreviewAttachment(null)}
              title="关闭"
            >&times;</button>
            <img src={previewAttachment.previewUrl} alt={previewAttachment.filename} className="imagePreviewImg" />
            <div className="imagePreviewInfo">{previewAttachment.filename}</div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function ApprovalModeIcon({ mode }: { mode: ApprovalMode }) {
  return <SecuredIcon className={`approvalModeIcon ${mode === "full-access" ? "fullAccess" : "ask"}`} aria-hidden="true" />;
}

function InteractionModeIcon({ mode }: { mode: InteractionMode }) {
  const icon =
    mode === "direct" ? <ChatBubbleHistoryIcon /> :
    mode === "supervised" ? <ChartIcon /> :
    <UsergroupIcon />;
  return <span className={`interactionModeIcon ${mode}`} aria-hidden="true">{icon}</span>;
}

function PermissionApprovalPanel(props: {
  permission: PendingPermission;
  agentLabel: string;
  resolving: boolean;
  onDecision: (decision: PermissionDecision) => void;
}) {
  const detail = props.permission.input || props.permission.locations?.join("、");
  return (
    <section className="permissionApproval" aria-label={`${props.agentLabel} 请求权限`}>
      <span className="permissionApprovalIcon"><ApprovalModeIcon mode="ask" /></span>
      <div className="permissionApprovalContent">
        <strong>{props.agentLabel} 请求批准</strong>
        <span>{props.permission.title}</span>
        {detail ? <code title={detail}>{detail}</code> : null}
      </div>
      <div className="permissionApprovalActions">
        <button type="button" className="permissionRejectBtn" disabled={props.resolving} onClick={() => props.onDecision("reject")}>拒绝</button>
        <button type="button" className="permissionAllowBtn" disabled={props.resolving} onClick={() => props.onDecision("allow")}>
          {props.resolving ? <span className="sendSpinner" aria-hidden="true" /> : "允许一次"}
        </button>
      </div>
    </section>
  );
}

function ElicitationPanel(props: {
  elicitation: PendingElicitation;
  agentLabel: string;
  resolving: boolean;
  onResponse: (response: ElicitationResponse) => void;
}) {
  const schema = props.elicitation.requestedSchema;
  const fields = Object.entries(schema?.properties ?? {});
  const hasUnsupportedFields = fields.some(([, field]) => (
    !["string", "number", "integer", "boolean", "array"].includes(field.type) ||
    (field.type === "array" && !field.items)
  ));
  const [values, setValues] = useState<ElicitationContent>(() => {
    const defaults: ElicitationContent = {};
    for (const [name, field] of fields) {
      defaults[name] = field.default ?? (field.type === "boolean" ? false : field.type === "array" ? [] : "");
    }
    return defaults;
  });
  const [error, setError] = useState<string | null>(null);

  if (props.elicitation.mode === "url") {
    return (
      <section className="elicitationPanel" aria-label={`${props.agentLabel} 请求外部输入`}>
        <span className="elicitationIcon" aria-hidden="true">?</span>
        <div className="elicitationContent">
          <strong>{props.agentLabel} 需要你的输入</strong>
          <span>{props.elicitation.message}</span>
          {props.elicitation.url && isSafeExternalUrl(props.elicitation.url) ? (
            <a href={props.elicitation.url} target="_blank" rel="noreferrer" className="elicitationUrl">
              打开外部页面
            </a>
          ) : null}
          {props.elicitation.url ? <code title={props.elicitation.url}>{props.elicitation.url}</code> : null}
        </div>
        <div className="elicitationActions">
          <button type="button" className="permissionRejectBtn" disabled={props.resolving} onClick={() => props.onResponse({ action: "decline" })}>拒绝</button>
          <button type="button" className="permissionAllowBtn" disabled={props.resolving} onClick={() => props.onResponse({ action: "accept" })}>
            {props.resolving ? <span className="sendSpinner" aria-hidden="true" /> : "同意继续"}
          </button>
        </div>
      </section>
    );
  }

  if (props.elicitation.mode !== "form" || !schema || hasUnsupportedFields) {
    return (
      <section className="elicitationPanel" aria-label={`${props.agentLabel} 请求输入`}>
        <span className="elicitationIcon" aria-hidden="true">?</span>
        <div className="elicitationContent">
          <strong>{props.agentLabel} 请求输入</strong>
          <span>{props.elicitation.message}</span>
          <small>当前版本暂不支持这种输入类型。</small>
        </div>
        <div className="elicitationActions">
          <button type="button" className="permissionRejectBtn" disabled={props.resolving} onClick={() => props.onResponse({ action: "cancel" })}>关闭</button>
        </div>
      </section>
    );
  }

  const formSchema = schema;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content: ElicitationContent = {};
    const required = new Set(formSchema.required ?? []);

    for (const [name, field] of fields) {
      const value = values[name];
      const isEmpty = value === "" || (Array.isArray(value) && value.length === 0);
      if (required.has(name) && isEmpty) {
        setError(`请填写“${field.title || name}”`);
        return;
      }
      if (isEmpty) continue;

      if (field.type === "number" || field.type === "integer") {
        const numberValue = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(numberValue) || (field.type === "integer" && !Number.isInteger(numberValue))) {
          setError(`“${field.title || name}”必须是有效的${field.type === "integer" ? "整数" : "数字"}`);
          return;
        }
        if (field.minimum != null && numberValue < field.minimum || field.maximum != null && numberValue > field.maximum) {
          setError(`“${field.title || name}”超出允许范围`);
          return;
        }
        content[name] = numberValue;
        continue;
      }

      if (field.type === "string" && typeof value === "string") {
        if (field.minLength != null && value.length < field.minLength || field.maxLength != null && value.length > field.maxLength) {
          setError(`“${field.title || name}”长度不符合要求`);
          return;
        }
      }
      if (field.type === "array" && Array.isArray(value)) {
        if (field.minItems != null && value.length < field.minItems || field.maxItems != null && value.length > field.maxItems) {
          setError(`“${field.title || name}”选择数量不符合要求`);
          return;
        }
      }
      content[name] = value;
    }

    setError(null);
    props.onResponse({ action: "accept", content });
  }

  return (
    <section className="elicitationPanel elicitationFormPanel" aria-label={`${props.agentLabel} 请求输入`}>
      <span className="elicitationIcon" aria-hidden="true">?</span>
      <form className="elicitationForm" onSubmit={submit}>
        <strong>{props.agentLabel} 需要你的输入</strong>
        <span>{props.elicitation.message}</span>
        {formSchema.title ? <h4>{formSchema.title}</h4> : null}
        {formSchema.description ? <small>{formSchema.description}</small> : null}
        {fields.map(([name, field]) => (
          <ElicitationField
            key={name}
            name={name}
            field={field}
            value={values[name]}
            onChange={(value) => setValues((current) => ({ ...current, [name]: value }))}
          />
        ))}
        {error ? <div className="elicitationError" role="alert">{error}</div> : null}
        <div className="elicitationActions">
          <button type="button" className="permissionRejectBtn" disabled={props.resolving} onClick={() => props.onResponse({ action: "decline" })}>拒绝</button>
          <button type="submit" className="permissionAllowBtn" disabled={props.resolving}>
            {props.resolving ? <span className="sendSpinner" aria-hidden="true" /> : "提交"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ElicitationField(props: {
  name: string;
  field: ElicitationFieldSchema;
  value: string | number | boolean | string[] | undefined;
  onChange: (value: string | number | boolean | string[]) => void;
}) {
  const label = props.field.title || props.name;
  const options = props.field.enum?.map((value) => ({ const: value, title: value }))
    ?? props.field.oneOf
    ?? (props.field.items?.enum?.map((value) => ({ const: value, title: value }))
      ?? props.field.items?.anyOf);
  const isMulti = props.field.type === "array";

  return (
    <label className="elicitationField">
      <span>{label}{props.field.description ? <small>{props.field.description}</small> : null}</span>
      {options && !isMulti ? (
        <select value={typeof props.value === "string" ? props.value : ""} onChange={(event) => props.onChange(event.target.value)}>
          <option value="">请选择</option>
          {options.map((option) => <option key={option.const} value={option.const}>{option.title}</option>)}
        </select>
      ) : isMulti ? (
        <select multiple value={Array.isArray(props.value) ? props.value : []} onChange={(event) => props.onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>
          {(options ?? []).map((option) => <option key={option.const} value={option.const}>{option.title}</option>)}
        </select>
      ) : props.field.type === "boolean" ? (
        <input type="checkbox" checked={props.value === true} onChange={(event) => props.onChange(event.target.checked)} />
      ) : (
        <input
          type={props.field.type === "number" || props.field.type === "integer" ? "number" : "text"}
          value={typeof props.value === "string" || typeof props.value === "number" ? props.value : ""}
          min={props.field.minimum ?? undefined}
          max={props.field.maximum ?? undefined}
          step={props.field.type === "integer" ? 1 : "any"}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function MentionMenu(props: {
  agentsById: Map<AgentId, AgentState>;
  candidates: AgentId[];
  selectedIndex: number;
  onSelect: (agentId: AgentId) => void;
}) {
  return (
    <div className="mentionMenu" role="listbox" aria-label="Choose agent">
      {props.candidates.map((agentId, index) => {
        const agent = props.agentsById.get(agentId);
        const status = agent?.status ?? "idle";
        return (
          <button
            key={agentId}
            className={index === props.selectedIndex ? "selected" : ""}
            type="button"
            role="option"
            aria-selected={index === props.selectedIndex}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onSelect(agentId)}
          >
            <span className="mentionName">
              <span className={`mentionDot ${status}`} aria-hidden="true" />
              <span>@{agent?.label ?? agentId}</span>
            </span>
            <small>{status}</small>
          </button>
        );
      })}
      <div className="mentionHint">↑↓ select · Tab/Enter confirm · Esc close</div>
    </div>
  );
}

function AgentButton(props: { agent: AgentState; selected: boolean; showLiveStatus?: boolean; onClick: () => void; onConfig?: () => void }) {
  const showStatus = props.showLiveStatus !== false || props.agent.runtimeAvailable === false;
  const isRunning = props.showLiveStatus !== false && (props.agent.status === "running" || props.agent.status === "starting");
  const isRuntimeMissing = props.agent.runtimeAvailable === false;
  const meta = runtimeMeta(props.agent.runtime);
  return (
    <button
      className={`agentButton ${props.selected && !isRunning ? "selected" : ""} ${isRunning ? "agentRunning" : ""} ${isRuntimeMissing ? "agentRuntimeMissing" : ""} ${showStatus ? "" : "statusHidden"}`}
      onClick={props.onClick}
      type="button"
      title={isRuntimeMissing ? `${meta.label} 未安装，该数字员工无法运行` : undefined}
    >
      {showStatus ? <span className={`statusDot ${isRuntimeMissing ? "runtimeMissing" : props.agent.status}`} aria-hidden="true" /> : null}
      <span className="agentText">
        <span className="agentTextRow">
          <strong>
            {props.agent.label}
            {isRunning && <span className="agentRunningLabel">运行中</span>}
            <RuntimeBadge runtime={props.agent.runtime} />
          </strong>
          {props.onConfig && (
            <span
              className="agentConfigIcon"
              role="button"
              tabIndex={0}
              title="编辑配置"
              onClick={(e) => { e.stopPropagation(); props.onConfig!(); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); props.onConfig!(); } }}
            >
              <EditIcon />
            </span>
          )}
        </span>
        <small>
          {isRuntimeMissing ? (
            <>
              {" · "}<a href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="agentInstallLink" onClick={(e) => e.stopPropagation()}>安装 ↗</a>
            </>
          ) : null}
        </small>
      </span>
    </button>
  );
}

function MessageRow({
  message,
  agent,
  parentMessage,
  agentsById,
}: {
  message: ChatMessage;
  agent?: AgentState;
  parentMessage?: ChatMessage;
  agentsById: Map<AgentId, AgentState>;
}) {
  const author = message.kind === "user" ? "你" : message.kind === "agent" ? agent?.label ?? message.agentId ?? "数字员工" : "系统";
  const isRunning = message.status === "running";
  const isCancelling = message.status === "cancelling" || message.runStatus === "cancelling";
  const isQueued = message.runStatus === "queued";
  const isAgentRun = message.kind === "agent" && Boolean(message.runId);
  const isLiveRun = isAgentRun && (isRunning || isCancelling || isQueued);
  // 仅在回合仍处于执行态时提前展示显式 final_answer；排队或取消中的
  // 消息不能继续沿用已经收到的最终分片作为正文。
  const liveFinalAnswer = isRunning ? getLiveFinalAnswer(message.activity) : null;
  const handoffSummary = getAgentHandoffSummary(message, parentMessage, agentsById);
  const compactHandoffSource = parentMessage?.kind === "agent"
    ? agentsById.get(parentMessage.agentId ?? "")?.label ?? parentMessage.agentId ?? "数字员工"
    : null;
  const isProgressPlaceholder = message.kind === "agent"
    && (message.content.endsWith(" is working...") || message.content.endsWith(" queued..."));
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyResetTimer = useRef<number | null>(null);
  const canCopyMessage = message.content.trim().length > 0 && !isProgressPlaceholder;

  useEffect(() => () => {
    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
  }, []);

  async function copyMessage() {
    if (!canCopyMessage) {
      return;
    }

    try {
      await navigator.clipboard.writeText(message.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    if (copyResetTimer.current !== null) {
      window.clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <article className={`message ${message.kind}`}>
      <div className="messageMeta">
        {message.kind === "agent" ? (
          <Avatar
            className="messageAuthorAvatar"
            size="24px"
            style={{ backgroundColor: agentColor(message.agentId ?? agent?.id ?? "agent") }}
            aria-label={`${author}头像`}
          >
            {author.slice(0, 1)}
          </Avatar>
        ) : null}
        <strong>{author}</strong>
        {message.kind === "agent" && agent ? <RuntimeBadge runtime={agent.runtime} /> : null}
        {message.status ? <span className={`statusPill ${message.status}`}>{messageStatusLabel(message.status)}</span> : null}
        {/* 用户消息显示创建时间 */}
        {message.kind === "user" && message.createdAt ? (
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        ) : null}
        {/* Agent 和 system 消息显示持续时间 */}
        {message.kind !== "user" ? (
          <DurationDisplay
            startedAt={message.startedAt ?? (isRunning ? message.createdAt : undefined)}
            completedAt={message.completedAt}
            isRunning={isRunning}
          />
        ) : null}
        {canCopyMessage ? (
          <button
            className={`messageCopyBtn ${copyState}`}
            type="button"
            onClick={(event) => { event.stopPropagation(); void copyMessage(); }}
            aria-label={copyState === "copied" ? "已复制消息" : "复制消息"}
            title={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制消息"}
          >
            {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
          </button>
        ) : null}
      </div>
      {message.sessionId || message.runIndex ? (
        <div className="sessionInfo">
          {message.sessionId ? (
            <span>session: {message.sessionId}</span>
          ) : null}
          {message.runIndex ? <span>第 {message.runIndex} 次执行</span> : null}
        </div>
      ) : null}
      {compactHandoffSource ? (
        <div className="handoffSummary" title={handoffSummary ?? undefined}>
          <span className="handoffSourcePrefix">来自</span>
          <span>{compactHandoffSource}</span>
        </div>
      ) : handoffSummary && parentMessage?.kind !== "user" ? (
        <div className="handoffSummary" title={handoffSummary}>{handoffSummary}</div>
      ) : null}
      {isAgentRun
        ? isLiveRun
          ? liveFinalAnswer
            ? <SettledRunProcess message={message} hideFinalAnswer />
            : <LiveRunProcess message={message} isCancelling={isCancelling} />
          : <SettledRunProcess message={message} />
        : null}
      <div className="messageBody">
        {isProgressPlaceholder && !liveFinalAnswer ? (
          <span className="messageProgressText">{isCancelling ? "正在取消" : isQueued ? "等待处理" : "正在处理"}</span>
        ) : message.kind === "agent" ? <MarkdownContent content={liveFinalAnswer ?? message.content} /> : <PlainText content={message.content} />}
        {message.attachments?.length ? (
          <div className="messageAttachments">
            {message.attachments.map((att) => (
              att.kind === "image" ? (
                <a
                  key={att.id}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="messageAttachmentLink"
                >
                  <img
                    src={att.url}
                    alt={att.filename}
                    className="messageAttachmentThumb"
                    loading="lazy"
                  />
                </a>
              ) : (
                <a
                  key={att.id}
                  href={att.url}
                  download={att.filename}
                  className="messageAttachmentFile"
                  title={`下载 ${att.filename}`}
                >
                  <AttachIcon className="messageAttachmentFileIcon" />
                  <span className="messageAttachmentFileName">{att.filename}</span>
                  <span className="messageAttachmentFileSize">{formatFileSize(att.size)}</span>
                </a>
              )
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

type ProcessTimelineEntry =
  | { kind: "text"; text: string; timestamp: string; stream: "progress" | "answer"; isFinal?: boolean }
  | { kind: "tools"; activities: ProcessToolActivity[] }
  | { kind: "tool-summary"; count: number; failedCount: number };

/** Preserve the ACP order while combining adjacent same-stream text chunks and tool events. */
export function buildProcessTimeline(
  activity: AgentActivityEvent[] | undefined,
  persistedTimeline?: PersistedProcessTimelineEntry[] | null,
  options?: { hideFinalAnswer?: boolean },
): ProcessTimelineEntry[] {
  const timeline: ProcessTimelineEntry[] = [];

  for (const item of activity ?? []) {
    if (item.type === "process.text") {
      if (!item.text) continue;
      if (options?.hideFinalAnswer && item.isFinal) continue;
      const stream = item.stream ?? "progress";
      const isFinal = item.isFinal === true;
      const previous = timeline.at(-1);
      // 仅相邻同 stream 的文本合并，避免过程叙述与回答正文混入同一文本块。
      if (previous?.kind === "text" && previous.stream === stream && Boolean(previous.isFinal) === isFinal) {
        previous.text += item.text;
      } else {
        timeline.push({ kind: "text", text: item.text, timestamp: item.timestamp, stream, ...(isFinal ? { isFinal: true } : {}) });
      }
      continue;
    }

    if (item.type !== "tool.started" && item.type !== "tool.completed" && item.type !== "tool.failed" && item.type !== "error") {
      continue;
    }

    const previous = timeline.at(-1);
    if (previous?.kind === "tools") {
      previous.activities.push(item);
    } else {
      timeline.push({ kind: "tools", activities: [item] });
    }
  }

  if (timeline.length === 0 && persistedTimeline?.length) {
    return persistedTimeline.map((entry) => entry.type === "text"
      ? { kind: "text", text: entry.text, timestamp: "", stream: "progress" as const }
      : { kind: "tool-summary", count: entry.count, failedCount: entry.failedCount });
  }
  return timeline;
}

function toolExecutionLabel(execution: ProcessToolExecution): string {
  if (execution.status === "failed") return `${execution.name} 执行失败`;
  if (execution.status === "completed") return `${execution.name} 已完成`;
  return `正在执行 ${execution.name}`;
}

function ToolActivityGroup({ activities, live }: { activities: ProcessToolActivity[]; live: boolean }) {
  const executions = collapseToolExecutions(activities);
  const latest = executions.at(-1);
  if (!latest) return null;

  return (
    <details className={`processToolGroup${live ? " live" : ""}`}>
      <summary title={latest.input ?? latest.summary ?? toolExecutionLabel(latest)}>
        <TerminalIcon className="processToolIcon" aria-hidden="true" />
        <span key={`${latest.key}-${latest.status}`} className={`processToolLatest ${latest.status}`}>{toolExecutionLabel(latest)}</span>
        {executions.length > 1 ? <span className="processToolCount">{executions.length} 项</span> : null}
        <ChevronRightIcon className="processToolChevron" aria-hidden="true" />
      </summary>
      <ol className="processToolList" aria-label="全部工具执行">
        {executions.map((execution) => (
          <li key={execution.key} className={execution.status}>
            <span className="processToolStatus" aria-hidden="true" />
            <span className="processToolEntry">
              <strong>{toolExecutionLabel(execution)}</strong>
              {execution.input ? <span>{execution.input}</span> : null}
              {execution.summary ? <span>{execution.summary}</span> : null}
            </span>
            <time dateTime={execution.timestamp}>{formatTime(execution.timestamp)}</time>
          </li>
        ))}
      </ol>
    </details>
  );
}

function PersistedToolActivityGroup({ count, failedCount }: { count: number; failedCount: number }) {
  return (
    <div className="processToolSummary" title="刷新后仅保留工具调用统计">
      <TerminalIcon className="processToolIcon" aria-hidden="true" />
      <span>已执行 {count} 次工具调用</span>
      {failedCount > 0 ? <span className="processToolSummaryError">{failedCount} 次失败</span> : null}
    </div>
  );
}

function ProcessTimeline({ message, live = false, hideFinalAnswer = false }: { message: ChatMessage; live?: boolean; hideFinalAnswer?: boolean }) {
  const timeline = buildProcessTimeline(message.activity, message.processTimeline, { hideFinalAnswer });
  if (timeline.length === 0) return null;
  return (
    <div className="processTimeline">
      {timeline.map((entry, index) => entry.kind === "text" ? (
        <div
          key={`text-${index}`}
          className="processNarrative"
        >
          <MarkdownContent content={entry.text} />
        </div>
      ) : entry.kind === "tools" ? (
        <ToolActivityGroup key={`tools-${index}`} activities={entry.activities} live={live} />
      ) : (
        <PersistedToolActivityGroup key={`tool-summary-${index}`} count={entry.count} failedCount={entry.failedCount} />
      ))}
    </div>
  );
}

/** 运行中的过程区：Plan 状态板 + ACP 有序过程流。运行期间回答正文也按到达顺序留在时间线。 */
function LiveRunProcess({ message, isCancelling }: { message: ChatMessage; isCancelling: boolean }) {
  const hasProcess = Boolean(message.plan || buildProcessTimeline(message.activity, message.processTimeline).length);
  if (!hasProcess) return null;

  return (
    <div className={`liveProcess${isCancelling ? " cancelling" : ""}`} aria-label="执行过程">
      <div className="liveProcessHeader">
        <span>执行过程</span>
        <span>实时更新</span>
      </div>
      <ProcessTimeline message={message} live />
      {message.plan ? <PlanBoard plan={message.plan} /> : null}
    </div>
  );
}

/** 运行结算后的折叠过程区；正文区只显示最终回复。 */
function SettledRunProcess({ message, hideFinalAnswer = false }: { message: ChatMessage; hideFinalAnswer?: boolean }) {
  const activity = message.activity ?? [];
  const plan = message.plan ?? undefined;
  const timeline = buildProcessTimeline(activity, message.processTimeline, { hideFinalAnswer });
  if (!plan && timeline.length === 0) {
    return null;
  }

  const toolStats = timeline.reduce((stats, entry) => {
    if (entry.kind === "tool-summary") {
      stats.count += entry.count;
      stats.failedCount += entry.failedCount;
    } else if (entry.kind === "tools") {
      const executions = collapseToolExecutions(entry.activities);
      stats.count += executions.length;
      stats.failedCount += executions.filter((execution) => execution.status === "failed").length;
    }
    return stats;
  }, { count: 0, failedCount: 0 });

  return (
    <details className="settledProcess">
      <summary>
        <span className="settledProcessTitle">执行过程</span>
        <span className="settledProcessMeta">
          {toolStats.count > 0 ? <span>{toolStats.count} 次工具调用</span> : null}
          {toolStats.failedCount > 0 ? <span className="settledProcessError">{toolStats.failedCount} 次失败</span> : null}
          {toolStats.count === 0 && toolStats.failedCount === 0 && (plan || timeline.length > 0) ? <span>过程记录</span> : null}
        </span>
        <ChevronRightIcon className="settledProcessChevron" aria-hidden="true" />
      </summary>
      <div className="settledProcessBody">
        <ProcessTimeline message={message} hideFinalAnswer={hideFinalAnswer} />
        {plan ? <PlanBoard plan={plan} /> : null}
      </div>
    </details>
  );
}

function getLiveFinalAnswer(activity: AgentActivityEvent[] | undefined): string | null {
  const finalItems = (activity ?? [])
    .filter((item): item is Extract<AgentActivityEvent, { type: "process.text" }> => (
      item.type === "process.text" && item.stream === "answer" && item.isFinal === true
    ));
  // 与服务端 selectFinalAnswer 保持一致：多个响应组存在时只展示最后一个 final 组。
  const finalGroup = finalItems.at(-1)?.answerGroup ?? "";
  const answer = finalItems
    .filter((item) => (item.answerGroup ?? "") === finalGroup)
    .map((item) => item.text)
    .join("");
  return answer || null;
}

function PlanBoard({ plan }: { plan: AgentPlanSnapshot }) {
  if (plan.format === "items") {
    return (
      <div className="planBoard" aria-label="执行计划">
        {plan.entries.map((entry, index) => (
          <div key={index} className={`planStep ${entry.status}`}>
            <span className="planStepIndicator" aria-hidden="true" />
            <span className="planStepContent">{entry.content}</span>
          </div>
        ))}
      </div>
    );
  }
  if (plan.format === "markdown") {
    return (
      <div className="planBoard planBoardMarkdown" aria-label="执行计划">
        <MarkdownContent content={plan.content} />
      </div>
    );
  }
  return (
    <div className="planBoard planBoardFile" aria-label="执行计划">
      计划文件：<code>{plan.uri}</code>
    </div>
  );
}

function messageStatusLabel(status: ChatMessage["status"]): string {
  switch (status) {
    case "sent": return "已发送";
    case "running": return "运行中";
    case "cancelling": return "取消中";
    case "done": return "已完成";
    case "error": return "失败";
    case "cancelled": return "已取消";
    default: return status ?? "";
  }
}

function DurationDisplay({ startedAt, completedAt, isRunning }: { startedAt?: string; completedAt?: string; isRunning: boolean }) {
  const [elapsed, setElapsed] = useState<number>(0);

  useEffect(() => {
    if (!isRunning || !startedAt) {
      return;
    }

    const startMs = new Date(startedAt).getTime();
    setElapsed(Date.now() - startMs);
    const timer = setInterval(() => setElapsed(Date.now() - startMs), 1000);
    return () => clearInterval(timer);
  }, [isRunning, startedAt]);

  if (!startedAt) {
    return null;
  }

  const startLabel = formatTime(startedAt);

  if (isRunning) {
    return (
      <>
        <time dateTime={startedAt}>{startLabel}</time>
        <span className="durationRunning">进行中 {formatDuration(elapsed)}</span>
      </>
    );
  }

  if (completedAt) {
    const endLabel = formatTime(completedAt);
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return (
      <>
        <time dateTime={startedAt}>{startLabel}</time>
        <span className="durationArrow">&rarr;</span>
        <time dateTime={completedAt}>{endLabel}</time>
        <span className="durationElapsed">({formatDuration(durationMs)})</span>
      </>
    );
  }

  return <time dateTime={startedAt}>{startLabel}</time>;
}

const RUNTIMES: readonly AgentRuntimeKind[] = AGENT_RUNTIME_PRIORITY;

// Global settings - only runtime-level config
function SystemSettingsPanel({ onClose }: { onClose: () => void }) {
  const [enableRunLogs, setEnableRunLogs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    fetch("/api/global-config")
      .then((r) => r.json())
      .then((cfg: { enableRunLogs?: boolean }) => {
        setEnableRunLogs(cfg.enableRunLogs ?? false);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function save() {
    setSaving(true);
    setSavedMsg("");
    fetch("/api/global-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enableRunLogs,
      }),
    })
      .then((r) => {
        if (!r.ok) return r.json().then((err) => Promise.reject(err));
        return r.json();
      })
      .then(() => {
        setSaving(false);
        onClose();
      })
      .catch((err) => {
        setSaving(false);
        setSavedMsg(err?.message ?? "保存失败");
      });
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel workspaceConfigPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>全局设置</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        <div className="settingsBody">
          {loading ? (
            <div className="settingsPlaceholder">
              <span>加载中...</span>
            </div>
          ) : (
            <div className="settingsSection">
              <label className="settingsLabel">运行日志</label>
              <span className="workspaceConfigHint">记录数字员工运行日志到本地（用于问题排查，会占用磁盘空间）</span>
              <div className="toggleRow">
                <input
                  type="checkbox"
                  id="enableRunLogs"
                  checked={enableRunLogs}
                  onChange={(e) => setEnableRunLogs(e.target.checked)}
                />
                <label htmlFor="enableRunLogs">{enableRunLogs ? "已开启" : "已关闭"}</label>
              </div>
            </div>
          )}
        </div>
        <div className="modalFooter">
          {savedMsg ? <span className="settingsSavedMsg">{savedMsg}</span> : null}
          <button type="button" onClick={onClose}>关闭</button>
          <button type="button" className="primaryBtn" onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeSetupBanner({ agents, isRefreshing, onRefresh }: { agents: AgentState[]; isRefreshing: boolean; onRefresh: () => void }) {
  const missingRuntimes = uniqueMissingRuntimes(agents);
  return (
    <div className="runtimeSetupBanner">
      <div className="runtimeSetupText">
        <strong>运行环境未就绪</strong>
        <span>
          {agents.map((agent) => agent.label || agent.id).join("、")} 需要安装对应命令行工具。安装完成后点击重新检测即可继续使用。
        </span>
      </div>
      <div className="runtimeSetupCommands" aria-label="运行环境安装命令">
        {missingRuntimes.map((runtime) => {
          const meta = runtimeMeta(runtime);
          return (
            <code key={runtime} className="runtimeInstallCommand">
              {meta.installCommand}
            </code>
          );
        })}
      </div>
      <div className="runtimeSetupActions">
        {missingRuntimes.map((runtime) => {
          const meta = runtimeMeta(runtime);
          return (
            <a key={runtime} href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="runtimeInstallBtn">
              安装 {meta.label}
            </a>
          );
        })}
        <button type="button" className="runtimeRefreshBtn" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? "检测中..." : "重新检测"}
        </button>
      </div>
    </div>
  );
}

function uniqueMissingRuntimes(agents: readonly Pick<AgentState, "runtime">[]): AgentRuntimeKind[] {
  const seen = new Set<AgentRuntimeKind>();
  const result: AgentRuntimeKind[] = [];
  for (const agent of agents) {
    if (!seen.has(agent.runtime)) {
      seen.add(agent.runtime);
      result.push(agent.runtime);
    }
  }
  return result;
}

// A preset template card, shared by the workspace-creation picker and the workspace config panel.
function PresetCard({ preset, selected, onClick }: { preset: WorkspacePreset; selected?: boolean; onClick: () => void }) {
  const classes = [
    "presetCard",
    selected ? "presetCardSelected" : "",
    preset.recommended ? "presetCardRecommended" : "",
  ].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} aria-pressed={selected} onClick={onClick}>
      <span className="presetName">{preset.name}</span>
      <span className="presetDesc">{preset.description}</span>
      {preset.recommended ? <span className="presetBadge">推荐</span> : null}
    </button>
  );
}

// Workspace-level config - prompt and rules
function WorkspaceConfigPanel({ onClose, hasWorkspace, workspaceId, presets }: { onClose: () => void; hasWorkspace: boolean; workspaceId: string; presets: WorkspacePreset[] }) {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [rules, setRules] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    if (!hasWorkspace) {
      setLoading(false);
      return;
    }
    fetch(`/api/workspace-config?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => r.json())
      .then((cfg: { systemPrompt?: string; rules?: string[] }) => {
        setSystemPrompt(cfg.systemPrompt ?? "");
        setRules(cfg.rules ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [hasWorkspace, workspaceId]);

  function applyPreset(presetId: string) {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    const hasContent = systemPrompt.trim() || rules.some((r) => r.trim());
    if (hasContent && !window.confirm("应用模板将覆盖当前提示词和规则，是否继续？")) return;
    setSystemPrompt(preset.systemPrompt);
    setRules([...preset.rules]);
  }

  const activePresetId = matchPreset(systemPrompt, rules, presets);

  function addRule() {
    setRules((prev) => [...prev, ""]);
  }

  function updateRule(index: number, value: string) {
    setRules((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    if (!hasWorkspace) return;
    setSaving(true);
    setSavedMsg("");
    fetch(`/api/workspace-config?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: systemPrompt.trim(),
        rules: rules.map((r) => r.trim()).filter(Boolean),
      }),
    })
      .then((r) => {
        if (!r.ok) return r.json().then((err) => Promise.reject(err));
        return r.json();
      })
      .then(() => {
        setSaving(false);
        onClose();
      })
      .catch((err) => {
        setSaving(false);
        setSavedMsg(err?.message ?? "保存失败");
      });
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel workspaceConfigPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>工作区配置</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        <div className="settingsBody">
          {!hasWorkspace ? (
            <div className="settingsPlaceholder">
              <strong>请先选择或创建工作区</strong>
              <span>工作区配置作用于当前工作区下的所有会话。</span>
            </div>
          ) : loading ? (
            <div className="settingsPlaceholder">
              <span>加载中...</span>
            </div>
          ) : (
            <>
              {presets.length > 0 ? (
                <div className="settingsSection">
                  <label className="settingsLabel">应用模板</label>
                  <span className="workspaceConfigHint">选择模板一键填充提示词和规则（不改变已配置的数字员工），会覆盖当前内容。</span>
                  <div className="presetSelector">
                    {presets.map((preset) => (
                      <PresetCard key={preset.id} preset={preset} selected={activePresetId === preset.id} onClick={() => applyPreset(preset.id)} />
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="settingsSection">
                <label className="settingsLabel">工作区提示词</label>
                <span className="workspaceConfigHint">对所有会话生效的系统提示词。留空则不注入。</span>
                <textarea
                  className="workspaceConfigTextarea"
                  placeholder="例如：本项目使用 TypeScript + React，所有代码需严格类型检查。"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={5}
                />
              </div>
              <div className="settingsSection">
                <label className="settingsLabel">
                  工作区规则
                  <button type="button" className="settingsAddBtn" onClick={addRule} title="添加规则">+</button>
                </label>
                <span className="workspaceConfigHint">对所有会话生效的行为规则。留空则不注入。</span>
                {rules.length === 0 ? (
                  <div className="rulesEmptyHint">暂无规则。点击 + 添加一条。</div>
                ) : (
                  <div className="rulesList">
                    {rules.map((rule, i) => (
                      <div key={i} className="rulesRow">
                        <span className="rulesIndex">{i + 1}.</span>
                        <input
                          className="rulesInput"
                          value={rule}
                          onChange={(e) => updateRule(i, e.target.value)}
                          placeholder={`规则 ${i + 1}`}
                          onKeyDown={(e) => {
                            if (isImeComposition(e)) {
                              return;
                            }
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addRule();
                            }
                          }}
                        />
                        <button type="button" className="rulesRemoveBtn" onClick={() => removeRule(i)} title="删除规则">&times;</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="modalFooter">
          {savedMsg ? <span className="settingsSavedMsg">{savedMsg}</span> : null}
          <button type="button" onClick={onClose}>关闭</button>
          {hasWorkspace ? (
            <button type="button" className="primaryBtn" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AgentManagerPanel({
  onClose,
  workspaceId,
  onSaved,
  runtimeAvailability,
  focusedAgentId,
  isRefreshingRuntimes,
  onRefreshRuntimes,
  modelStates,
}: {
  onClose: () => void;
  workspaceId: string;
  onSaved: () => void;
  runtimeAvailability: AppState["runtimeAvailability"];
  focusedAgentId?: string | null;
  isRefreshingRuntimes: boolean;
  onRefreshRuntimes: () => void;
  modelStates: AppState["agentModelStates"];
}) {
  const [configs, setConfigs] = useState<AgentConfigWithModelState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [teamTemplates, setTeamTemplates] = useState<AgentTeamTemplate[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [isProbingModels, setIsProbingModels] = useState(false);
  const focusedAgentApplied = useRef(false);

  const availByRuntime = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const a of runtimeAvailability) {
      map.set(a.runtime, a.available);
    }
    return map;
  }, [runtimeAvailability]);

  function isRuntimeAvailable(runtime: AgentRuntimeKind): boolean | undefined {
    return availByRuntime.get(runtimeKindToCliKey(runtime));
  }

  // Fallback to "claude-code" to stay consistent with AGENT_RUNTIME_PRIORITY
  // and the server-side FALLBACK_RUNTIME in workspace-agent-presets.ts.
  const firstAvailableRuntime = useMemo((): AgentRuntimeKind => {
    for (const rt of RUNTIMES) {
      if (isRuntimeAvailable(rt) === true) return rt;
    }
    return "claude-code";
  }, [availByRuntime]);

  useEffect(() => {
    fetch(`/api/agents?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => r.json())
      .then((data) => { setConfigs(data as AgentConfigWithModelState[]); setLoading(false); })
      .catch(() => { setError("加载数字员工配置失败。"); setLoading(false); });
    fetch("/api/agent-teams")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setTeamTemplates(Array.isArray(data) ? data as AgentTeamTemplate[] : []))
      .catch(() => setTeamTemplates([]));
  }, []);

  async function probeModels(force = false, runtime?: AgentRuntimeKind, agentId?: AgentId) {
    if (isProbingModels) return;
    setIsProbingModels(true);
    try {
      const params = new URLSearchParams();
      if (force) params.set("force", "1");
      if (runtime) params.set("runtime", runtime);
      if (agentId) params.set("agentId", agentId);
      const query = params.toString();
      const paramsWithWorkspace = new URLSearchParams(query);
      paramsWithWorkspace.set("workspaceId", workspaceId);
      const response = await fetch(`/api/agents/probe-models?${paramsWithWorkspace.toString()}`, { method: "POST" });
      if (!response.ok) {
        setError("获取模型列表失败，请稍后重试。");
        return;
      }
      const probeResponse = await response.json() as AgentModelProbeResponse;
      setConfigs((current) => mergeModelProbeResponse(current, probeResponse));
    } catch {
      setError("获取模型列表失败，请检查本地运行时是否可用。");
    } finally {
      setIsProbingModels(false);
    }
  }

  useEffect(() => {
    if (!loading) void probeModels();
  }, [loading]);

  // 面板打开期间员工运行产生的模型快照（SSE agent.model_state）实时合并进列表，
  // 保证"当前模型"与可选列表反映 runtime 的最新状态。
  useEffect(() => {
    setConfigs((prev) => prev.map((config) => (
      modelStates[config.id] ? { ...config, modelState: modelStates[config.id] } : config
    )));
  }, [modelStates]);

  // Auto-expand the focused agent once configs are loaded
  useEffect(() => {
    if (!focusedAgentId || loading || focusedAgentApplied.current) return;
    const idx = (configs as AgentConfig[]).findIndex((c) => c.id === focusedAgentId);
    if (idx >= 0) {
      setExpandedIndex(idx);
      focusedAgentApplied.current = true;
    }
  }, [focusedAgentId, loading, configs]);

  function updateConfig(index: number, patch: Partial<AgentConfig>) {
    setConfigs((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addConfig() {
    setConfigs((prev) => [
      {
        id: `agent-${Date.now()}`,
        name: "",
        runtime: firstAvailableRuntime,
        systemPrompt: "",
        enabled: true,
      },
      ...prev,
    ]);
    setExpandedIndex(0);
  }

  function removeConfig(index: number) {
    setConfigs((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
  }

  function generateUniqueId(sourceId: string, existingConfigs: AgentConfig[]): string {
    const existingIds = new Set(existingConfigs.map((c) => c.id));
    let newId = `${sourceId}-copy`;
    let counter = 1;
    while (existingIds.has(newId)) {
      newId = `${sourceId}-copy-${counter}`;
      counter++;
    }
    return newId;
  }

  function copyConfig(index: number) {
    const source = configs[index];
    const newId = generateUniqueId(source.id, configs);
    // modelState 是源员工 id 的运行时快照，新副本尚未运行，不随复制带走。
    const { modelState: _sourceModelState, ...sourceConfig } = structuredClone(source);
    const copy: AgentConfigWithModelState = {
      ...sourceConfig,
      id: newId,
      name: `${source.name} (副本)`,
      enabled: false,
    };
    // 清空监督者的触发器配置，避免冲突
    if (copy.triggers) {
      copy.triggers = undefined;
    }
    setConfigs((prev) => [copy, ...prev]);
    setExpandedIndex(0);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/agents?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configs),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        setError(body.message ?? `保存失败 (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError("网络错误，保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/reset?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST" });
      if (!res.ok) {
        setError("重置失败。");
        return;
      }
      const data = await res.json() as AgentConfig[];
      setConfigs(data);
      onSaved();
    } catch {
      setError("网络错误，重置失败。");
    } finally {
      setSaving(false);
    }
  }

  async function applyTeam(teamId: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/apply-team?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok) {
        const body = await res.json() as { message?: string };
        setError(body.message ?? "应用团队模板失败。");
        return;
      }
      setConfigs(await res.json() as AgentConfig[]);
      onSaved();
    } catch {
      setError("网络错误，应用团队模板失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>数字员工团队</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        {loading ? <p className="settingsLoading">加载中...</p> : (
          <div className="settingsBody">
            <div className="agentManagerIntro">
              <strong>数字员工团队模板</strong>
              <span>内置团队模板包含一组预置的数字员工，点击“应用”会全部启用。新建工作区时选择对应模板也会自动预置该团队。</span>
            </div>
            {teamTemplates.length > 0 ? (
              <div className="agentTeamTemplates">
                {teamTemplates.map((team) => (
                  <div className="agentTeamTemplate" key={team.id}>
                    <div>
                      <strong>{team.name}</strong>
                      <span>{team.description}</span>
                    </div>
                    <button type="button" onClick={() => applyTeam(team.id)} disabled={saving}>应用</button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="runtimeProbeRow">
              <span>安装或更新命令行工具后，可以重新检测运行环境。</span>
              <button type="button" className="runtimeRefreshBtn" onClick={onRefreshRuntimes} disabled={isRefreshingRuntimes}>
                {isRefreshingRuntimes ? "检测中..." : "重新检测运行环境"}
              </button>
            </div>
            <button type="button" className="addBtn addBtnTop" onClick={addConfig}>+ 添加自定义数字员工</button>
            {configs.map((config, i) => {
              const isExpanded = expandedIndex === i;
              // 模型区按当前运行时展示模型列表、探测状态和重试入口（issue #142）。
              const modelSnapshot = config.modelState
                && config.modelState.runtimeKind === config.runtime
                ? config.modelState
                : undefined;
              const modelProbe = config.modelProbe?.runtimeKind === config.runtime ? config.modelProbe : undefined;
              return (
                <div key={`config-${i}`} className={`configCard ${isExpanded ? "configCardExpanded" : ""} ${!config.enabled ? "configCardDisabled" : ""}`}>
                  <div className="configCardHeader" onClick={() => setExpandedIndex(isExpanded ? null : i)}>
                    <div className="configCardSummary">
                      <label className="toggleSwitch" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={config.enabled} onChange={() => updateConfig(i, { enabled: !config.enabled })} />
                        <span className="toggleTrack" />
                      </label>
                      <span className="configCardName">{config.name || config.id}</span>
                      <span className="configCardPill configCardRuntime">{config.runtime}</span>
                    </div>
                    <div className="configCardActions">
                      <button type="button" className="copyBtn" onClick={(e) => { e.stopPropagation(); copyConfig(i); }} title="复制">📋</button>
                      <button type="button" className="removeBtn" onClick={(e) => { e.stopPropagation(); removeConfig(i); }} title="删除">&times;</button>
                      <span className={`configChevron ${isExpanded ? "configChevronOpen" : ""}`}>▶</span>
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="configCardBody">
                      <div className="configFields">
                        <div className="fieldWithHint">
                          <input placeholder="内部标识符" value={config.id} onChange={(e) => updateConfig(i, { id: e.target.value })} />
                          <span className="fieldHint" title="仅用于内部保存会话和运行记录，用户指派时使用名称。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="名称" value={config.name} onChange={(e) => updateConfig(i, { name: e.target.value })} />
                          <span className="fieldHint" title="显示在侧边栏和消息头中的可读名称。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="描述" value={config.description ?? ""} onChange={(e) => updateConfig(i, { description: e.target.value })} />
                          <span className="fieldHint" title="数字员工能力的简短描述。其他数字员工发现可协作成员时会看到此内容。">?</span>
                        </div>
                        <div className="pillGroup">
                          <span className="pillLabel">运行时 <span className="fieldHint" title="驱动该数字员工的本地运行时。协议适配由 Orbit 在内部处理。">?</span></span>
                          <div className="pillOptions">
                            {RUNTIMES.map((r) => {
                              const isAvail = isRuntimeAvailable(r);
                              const isMissing = isAvail === false;
                              const isCurrent = config.runtime === r;
                              const meta = runtimeMeta(r);
                              return (
                                <span key={r} className="pillBtnWrapper">
                                  <button
                                    type="button"
                                    className={`pillBtn ${isCurrent ? "pillActive" : ""} ${isMissing ? "pillMissing" : ""}`}
                                    onClick={() => updateConfig(i, { runtime: r })}
                                    title={isMissing ? `${meta.label} 未安装，安装后点击重新检测` : isAvail === true ? `${meta.label} 已就绪` : `${meta.label} 检测中...`}
                                  >
                                    {meta.label}
                                    {isAvail === true ? <span className="pillCheck"> ✓</span> : isAvail === undefined ? <span className="pillUnknown"> ?</span> : null}
                                  </button>
                                  {isMissing ? (
                                    <a href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="runtimePillInstallLink">
                                      安装
                                    </a>
                                  ) : null}
                                </span>
                              );
                            })}
                          </div>
                          {isRuntimeAvailable(config.runtime) === false && (() => {
                            const meta = runtimeMeta(config.runtime);
                            return (
                              <div className="runtimeInstallHint">
                                <span>未检测到 {meta.label}。请先安装，并确认终端中可以运行对应命令；安装后点击重新检测即可继续。</span>
                                {meta.installCommand ? <code className="runtimeInstallCommand">{meta.installCommand}</code> : null}
                                <a href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="runtimeInstallBtn">查看安装指南 ↗</a>
                                <button type="button" className="runtimeRefreshBtn" onClick={onRefreshRuntimes} disabled={isRefreshingRuntimes}>
                                  {isRefreshingRuntimes ? "检测中..." : "重新检测"}
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                        <AgentModelField
                          config={config}
                          snapshot={modelSnapshot}
                          probe={modelProbe}
                          onChange={(patch) => updateConfig(i, patch)}
                          onRefreshModels={() => void probeModels(true, config.runtime, config.id)}
                          isRefreshing={isProbingModels}
                        />
                        <div className="fieldWithHint fieldFullWidth">
                          <textarea placeholder="系统提示词" value={config.systemPrompt} onChange={(e) => updateConfig(i, { systemPrompt: e.target.value })} rows={3} />
                          <span className="fieldHint fieldHintTop" title="每次运行时发送给数字员工的指令。定义其角色、专业能力和行为约束。">?</span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {error ? <p className="settingsError">{error}</p> : null}
          </div>
        )}
        <div className="modalFooter">
          <button type="button" onClick={resetDefaults} disabled={saving}>恢复默认</button>
          <button type="button" onClick={save} disabled={saving}>{saving ? "保存中..." : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 员工模型选择区（issue #142）：列出 runtime 上报的模型单选列表，保存为员工
 * 偏好。偏好只在该员工下次运行开始时应用；探测失败或 runtime 不支持时保留状态和重试入口。
 */
function AgentModelField({ config, snapshot, probe, onChange, onRefreshModels, isRefreshing }: {
  config: AgentConfigWithModelState;
  snapshot?: AgentModelStateSnapshot;
  probe?: AgentConfigWithModelState["modelProbe"];
  onChange: (patch: Partial<AgentConfig>) => void;
  onRefreshModels: () => void;
  isRefreshing: boolean;
}) {
  // 偏好按 runtime 归属过滤：切换运行时后旧偏好不生效也不显示。
  const preferred = config.model?.runtimeKind === config.runtime
    ? config.model?.preferredModelId?.trim() || undefined
    : undefined;
  const probeStatus = probe?.status ?? (snapshot ? (snapshot.choices.length > 0 ? "ready" : "unsupported") : "idle");
  const choices = probeStatus === "ready" ? snapshot?.choices ?? [] : [];
  const nameOf = (value: string) => choices.find((choice) => choice.value === value)?.name ?? value;
  const preferredMissing = probeStatus === "ready"
    && preferred !== undefined
    && !choices.some((choice) => choice.value === preferred);
  return (
    <div className="modelField fieldFullWidth">
      <div className="modelFieldHeader">
        <span className="pillLabel">模型 <span className="fieldHint" title="该数字员工使用的模型。可选列表由所在运行时提供，每次运行开始时应用。">?</span></span>
        <button type="button" className="modelRefreshBtn" onClick={onRefreshModels} disabled={isRefreshing}>
          {isRefreshing ? "获取中..." : "刷新模型列表"}
        </button>
      </div>
      <div className="modelChoiceList">
        <label className={`modelChoice ${preferred === undefined ? "modelChoiceActive" : ""}`}>
          <input
            type="radio"
            name={`model-${config.id}`}
            checked={preferred === undefined}
            onChange={() => onChange({ model: undefined })}
          />
          <span>跟随运行时默认{probeStatus === "ready" && snapshot?.currentValueSource === "session" && snapshot.currentValue ? `（当前：${nameOf(snapshot.currentValue)}）` : ""}</span>
        </label>
        {choices.map((choice) => (
          <label key={choice.value} className={`modelChoice ${preferred === choice.value ? "modelChoiceActive" : ""}`}>
            <input
              type="radio"
              name={`model-${config.id}`}
              checked={preferred === choice.value}
              onChange={() => onChange({ model: { preferredModelId: choice.value, runtimeKind: config.runtime } })}
            />
            <span>
              {choice.name}
              {probeStatus === "ready" && snapshot?.currentValueSource === "session" && snapshot.currentValue === choice.value && preferred !== choice.value ? "（当前）" : ""}
            </span>
          </label>
        ))}
      </div>
      {probeStatus === "error" ? (
        <div className="modelHint modelHintWarn">{probe?.message ?? "模型列表获取失败，请重试。"}</div>
      ) : probeStatus === "unsupported" ? (
        <div className="modelHint">该运行时未提供可选模型列表。</div>
      ) : probeStatus === "loading" ? (
        <div className="modelHint">正在获取模型列表...</div>
      ) : preferredMissing ? (
        <div className="modelHint modelHintWarn">首选模型 {nameOf(preferred)} 当前不可用，下次运行将继续使用当前模型并在对话中提示。</div>
      ) : null}
      <div className="modelHint">模型选择在该数字员工下次运行时生效。</div>
    </div>
  );
}

export function mergeProbedConfigs(
  current: AgentConfigWithModelState[],
  probed: AgentConfigWithModelState[],
): AgentConfigWithModelState[] {
  const currentById = new Map(current.map((config) => [config.id, config]));
  const probedIds = new Set(probed.map((config) => config.id));
  return [
    ...probed.map((serverConfig) => {
      const localConfig = currentById.get(serverConfig.id);
      if (!localConfig) return serverConfig;
      return {
        ...serverConfig,
        ...localConfig,
        modelState: serverConfig.modelState,
        modelProbe: serverConfig.modelProbe,
      };
    }),
    ...current.filter((config) => !probedIds.has(config.id)),
  ];
}

export function mergeModelProbeResponse(
  current: AgentConfigWithModelState[],
  response: AgentModelProbeResponse,
): AgentConfigWithModelState[] {
  const merged = mergeProbedConfigs(current, response.configs);
  const target = response.target;
  if (!target) return merged;
  return merged.map((config) => (
    config.id === target.agentId && config.runtime === target.runtimeKind
      ? {
          ...config,
          modelState: target.modelState ?? undefined,
          modelProbe: target.modelProbe,
        }
      : config
  ));
}

function MarkdownContent({ content }: { content: string }) {
  const html = renderMarkdown(content);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PlainText({ content }: { content: string }) {
  return <div className="plainText">{content}</div>;
}

/**
 * 监工设置（issue #153）：运行时与模型偏好按会话保存。
 *
 * - 运行时与模型都可在开启复杂协作前后修改，入口在协作模式菜单里独立存在。
 * - 模型列表由所选运行时提供，按会话隔离探测（监工是所有会话共用的内部 ID）。
 * - 偏好按 runtime 归属门控：换运行时后旧偏好既不生效也不展示。
 */
function SupervisorSettingsPanel({
  workspaceId,
  conversationId,
  config,
  availability,
  onClose,
  onSave,
}: {
  workspaceId: string;
  conversationId: string;
  config: SupervisorConfig;
  availability: AppState["runtimeAvailability"];
  onClose: () => void;
  onSave: (config: SupervisorConfig) => Promise<void>;
}) {
  const [runtime, setRuntime] = useState<AgentRuntimeKind>(config.runtime);
  const [model, setModel] = useState<AgentModelPreference | undefined>(config.model);
  const [snapshot, setSnapshot] = useState<AgentModelStateSnapshot | undefined>(undefined);
  const [probe, setProbe] = useState<AgentModelProbeState | undefined>(undefined);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const probedRuntimeRef = useRef<AgentRuntimeKind | undefined>(undefined);

  async function refreshModels(targetRuntime: AgentRuntimeKind, force = false): Promise<void> {
    if (!workspaceId) return;
    setIsRefreshing(true);
    setError("");
    try {
      const params = new URLSearchParams({ workspaceId, runtime: targetRuntime, agentId: INTERNAL_SUPERVISOR_ID });
      // 监工是所有会话共用的内部 ID，模型快照按会话隔离，必须带会话维度。
      if (conversationId) params.set("conversationId", conversationId);
      if (force) params.set("force", "1");
      const response = await fetch(`/api/agents/probe-models?${params.toString()}`, { method: "POST" });
      const body = await response.json() as AgentModelProbeResponse;
      const target = body.target;
      if (target && target.runtimeKind === targetRuntime) {
        setSnapshot(target.modelState ?? undefined);
        setProbe(target.modelProbe);
      }
    } catch {
      setError("模型列表获取失败，请重试。");
    } finally {
      setIsRefreshing(false);
    }
  }

  // 首次打开按需探测当前监工的运行时；切换运行时后再探测一次新的。
  useEffect(() => {
    if (probedRuntimeRef.current === runtime) return;
    probedRuntimeRef.current = runtime;
    void refreshModels(runtime);
  }, [runtime, workspaceId, conversationId]);

  function chooseRuntime(next: AgentRuntimeKind): void {
    if (next === runtime) return;
    setRuntime(next);
    // 切换运行时后旧偏好不再生效，也不展示。
    setModel(undefined);
    setSnapshot(undefined);
    setProbe(undefined);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError("");
    try {
      await onSave(model ? { runtime, model } : { runtime });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存监工设置失败。");
    } finally {
      setSaving(false);
    }
  }

  const probeStatus = probe?.status ?? (snapshot ? (snapshot.choices.length > 0 ? "ready" : "unsupported") : "idle");
  const choices = probeStatus === "ready" ? snapshot?.choices ?? [] : [];
  const nameOf = (value: string) => choices.find((choice) => choice.value === value)?.name ?? value;
  // 偏好按 runtime 归属：与当前 runtime 不一致即不应用、不展示。
  const preferred = model?.runtimeKind === runtime ? model.preferredModelId?.trim() || undefined : undefined;
  const unavailable = new Set(
    availability.filter((item) => !item.available).map((item) => runtimeKindToCliKey(item.runtime)),
  );

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>监工设置</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        <div className="settingsBody">
          <p className="modelHint">
            选择监工使用的运行时与模型。修改从监工的下一次运行开始生效；更换运行时会重建监工会话，普通员工和历史消息不受影响。
          </p>
          <div className="modelField fieldFullWidth">
            <span className="pillLabel">运行时</span>
            <div className="modelChoiceList">
              {AGENT_RUNTIME_PRIORITY.map((kind) => (
                <label key={kind} className={`modelChoice ${runtime === kind ? "modelChoiceActive" : ""}`}>
                  <input
                    type="radio"
                    name="supervisor-runtime"
                    checked={runtime === kind}
                    onChange={() => chooseRuntime(kind)}
                  />
                  <span>
                    {runtimeMeta(kind).label}
                    {unavailable.has(runtimeKindToCliKey(kind)) ? "（当前不可用）" : ""}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div className="modelField fieldFullWidth">
            <div className="modelFieldHeader">
              <span className="pillLabel">模型 <span className="fieldHint" title="监工使用的模型。可选列表由所选运行时提供，每次运行开始时应用。">?</span></span>
              <button
                type="button"
                className="modelRefreshBtn"
                onClick={() => { void refreshModels(runtime, true); }}
                disabled={isRefreshing}
              >
                {isRefreshing ? "获取中..." : "刷新模型列表"}
              </button>
            </div>
            <div className="modelChoiceList">
              <label className={`modelChoice ${preferred === undefined ? "modelChoiceActive" : ""}`}>
                <input
                  type="radio"
                  name="supervisor-model"
                  checked={preferred === undefined}
                  onChange={() => setModel(undefined)}
                />
                <span>
                  跟随运行时默认
                  {probeStatus === "ready" && snapshot?.currentValueSource === "session" && snapshot.currentValue
                    ? `（当前：${nameOf(snapshot.currentValue)}）`
                    : ""}
                </span>
              </label>
              {choices.map((choice) => (
                <label key={choice.value} className={`modelChoice ${preferred === choice.value ? "modelChoiceActive" : ""}`}>
                  <input
                    type="radio"
                    name="supervisor-model"
                    checked={preferred === choice.value}
                    onChange={() => setModel({ preferredModelId: choice.value, runtimeKind: runtime })}
                  />
                  <span>
                    {choice.name}
                    {probeStatus === "ready" && snapshot?.currentValueSource === "session"
                      && snapshot.currentValue === choice.value && preferred !== choice.value ? "（当前）" : ""}
                  </span>
                </label>
              ))}
            </div>
            {probeStatus === "error" ? (
              <div className="modelHint modelHintWarn">{probe?.message ?? "模型列表获取失败，请重试。"}</div>
            ) : probeStatus === "unsupported" ? (
              <div className="modelHint">该运行时未提供可选模型列表。</div>
            ) : probeStatus === "loading" ? (
              <div className="modelHint">正在获取模型列表...</div>
            ) : null}
            <div className="modelHint">模型选择在监工下次运行时生效。</div>
          </div>
          {error ? <div className="modelHint modelHintWarn">{error}</div> : null}
          <div className="modalFooter">
            <button type="button" onClick={onClose} disabled={saving}>关闭</button>
            <button type="button" className="primaryBtn" onClick={() => { void save(); }} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function preferredSupervisionRuntime(availability: AppState["runtimeAvailability"]): AgentRuntimeKind | undefined {
  const available = new Set(availability.filter((item) => item.available).map((item) => item.runtime));
  return AGENT_RUNTIME_PRIORITY.find((runtime) => available.has(runtimeKindToCliKey(runtime)));
}

export function applyEvent(state: AppState, event: RuntimeEvent): AppState {
  if (event.type === "events.gap") return state;
  if (event.type === "running.updated") {
    return { ...state, runningSummaries: event.summaries };
  }

  if (event.type === "runtime.availability.updated") {
    const availMap = new Map<string, boolean>();
    for (const a of event.availability) {
      availMap.set(a.runtime, a.available);
    }
    return {
      ...state,
      runtimeAvailability: event.availability,
      agents: state.agents.map((agent) => {
        const cliKey = runtimeKindToCliKey(agent.runtime);
        const available = availMap.get(cliKey);
        return { ...agent, runtimeAvailable: available };
      }),
    };
  }

  // agent.model_state 通常是 workspace 级事件（无 conversationId），在会话过滤前处理，
  // 但不能让后台工作区的同名员工覆盖当前工作区的模型状态。
  if (event.type === "agent.model_state") {
    if (event.workspaceId !== state.workspace.id) return state;
    // 监工是所有会话共用的内部 ID，其快照带会话维度（issue #153）：
    // 其他会话的监工状态不能覆盖本页。
    if (event.conversationId !== undefined && event.conversationId !== state.conversation.id) return state;
    return {
      ...state,
      agentModelStates: { ...state.agentModelStates, [event.agentId]: event.modelState },
    };
  }

  if ("workspaceId" in event && event.workspaceId !== undefined && event.workspaceId !== state.workspace.id) {
    return state;
  }

  // For conversation-scoped events, only process if they match the active conversation
  if ("conversationId" in event && event.conversationId !== state.conversation.id) {
    return state;
  }

  if (event.type === "message.created") {
    return upsertMessage(state, event.message);
  }

  if (event.type === "message.updated") {
    return upsertMessage(state, event.message, {
      settleTransientActivity: event.settleTransientActivity,
      excludedAnswerGroup: event.excludedAnswerGroup,
    });
  }

  if (event.type === "agent.status") {
    return {
      ...state,
      agents: state.agents.map((agent) => (agent.id === event.agentId ? { ...agent, status: event.status } : agent)),
    };
  }

  if (event.type === "permission.requested") {
    if (state.pendingPermissions.some((permission) => permission.id === event.permission.id)) {
      return state;
    }
    return { ...state, pendingPermissions: [...state.pendingPermissions, event.permission] };
  }

  if (event.type === "permission.resolved") {
    return {
      ...state,
      pendingPermissions: state.pendingPermissions.filter((permission) => permission.id !== event.requestId),
    };
  }

  if (event.type === "elicitation.requested") {
    if (state.pendingElicitations.some((elicitation) => elicitation.id === event.elicitation.id)) {
      return state;
    }
    return { ...state, pendingElicitations: [...state.pendingElicitations, event.elicitation] };
  }

  if (event.type === "elicitation.resolved") {
    return {
      ...state,
      pendingElicitations: state.pendingElicitations.filter((elicitation) => elicitation.id !== event.requestId),
    };
  }

  if (event.type === "terminal.chunk") {
    return state;
  }

  if (event.type === "run.activity") {
    return {
      ...state,
      messages: state.messages.map((message) => {
        if (message.runId !== event.runId) {
          return message;
        }
        const activity = event.activity;
        if (activity.type === "process.text") {
          return {
            ...message,
            activity: appendTransientProcessActivity(message.activity ?? [], activity),
          };
        }
        if (activity.type === "plan.updated") {
          return { ...message, plan: activity.plan };
        }
        if (activity.type === "plan.removed") {
          if (message.plan?.id === undefined || message.plan.id === activity.planId) {
            return { ...message, plan: undefined };
          }
          return message;
        }
        return { ...message, activity: appendTransientProcessActivity(message.activity ?? [], activity) };
      }),
    };
  }

  return state;
}

export function upsertMessage(
  state: AppState,
  nextMessage: ChatMessage,
  options?: { settleTransientActivity?: boolean; excludedAnswerGroup?: string },
): AppState {
  const index = state.messages.findIndex((message) => message.id === nextMessage.id);
  if (index === -1) {
    return { ...state, messages: [...state.messages, nextMessage] };
  }

  // 中间更新保留页面实时值；终态事件按结算快照显式标记的分组剔除最终回答分片，
  // 保留当前页面的过程文本和完整工具明细。刷新后因没有 activity，才会回退到持久化摘要。
  return {
    ...state,
    messages: state.messages.map((message) => {
      if (message.id !== nextMessage.id) return message;
      const settledActivity = options?.settleTransientActivity
        ? removeSettledAnswerActivity(message.activity, options?.excludedAnswerGroup)
        : message.activity;
      return {
        ...nextMessage,
        activity: nextMessage.activity ?? settledActivity,
        processTimeline: nextMessage.processTimeline === undefined ? message.processTimeline : nextMessage.processTimeline,
        plan: nextMessage.plan === undefined ? message.plan : nextMessage.plan,
      };
    }),
  };
}

/** 只剔除结算事件显式标记的最终回答分组；无标识时保留全部实时活动（不误删部分回答）。 */
function removeSettledAnswerActivity(
  activity: AgentActivityEvent[] | undefined,
  excludedAnswerGroup?: string,
): AgentActivityEvent[] | undefined {
  if (!activity?.length) return activity;
  // 空字符串是有效分组（未分组回答），必须用 !== undefined 判断。
  if (excludedAnswerGroup === undefined) return activity;
  return activity.filter((item) => !(
    item.type === "process.text"
    && item.stream === "answer"
    && item.answerGroup === excludedAnswerGroup
  ));
}

function normalizeState(nextState: AppState): AppState {
  return {
    workspace: nextState.workspace ?? initialState.workspace,
    conversation: nextState.conversation ?? initialState.conversation,
    agents: nextState.agents?.length
      ? nextState.agents.map((agent) => ({ ...agent, runtime: agent.runtime ?? "claude-code" }))
      : initialState.agents,
    messages: nextState.messages ?? [],
    messageHistory: nextState.messageHistory ?? initialState.messageHistory,
    terminal: {
      ...(nextState.terminal ?? {}),
    },
    runningSummaries: nextState.runningSummaries ?? [],
    runtimeAvailability: nextState.runtimeAvailability ?? [],
    pendingPermissions: nextState.pendingPermissions ?? [],
    pendingElicitations: nextState.pendingElicitations ?? [],
    agentModelStates: nextState.agentModelStates ?? {},
  };
}

function RuntimeBadge({ runtime }: { runtime: AgentState["runtime"] }) {
  return <span className={`runtimeBadge ${runtime}`}>{runtimeLabel(runtime)}</span>;
}

function runtimeLabel(runtime: AgentState["runtime"]): string {
  if (runtime === "codebuddy") {
    return "CodeBuddy";
  }
  if (runtime === "codex") {
    return "Codex";
  }
  return "Claude Code";
}

function findMentionDraft(value: string, cursorIndex: number): { start: number; end: number; query: string } | null {
  const beforeCursor = value.slice(0, cursorIndex);
  const match = /(^|\s)@([^\s@:：]*)$/u.exec(beforeCursor);
  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  const start = beforeCursor.length - query.length - 1;
  return {
    start,
    end: cursorIndex,
    query,
  };
}

function connectionLabel(state: "connecting" | "live" | "offline"): string {
  if (state === "live") {
    return "在线";
  }
  if (state === "offline") {
    return "离线";
  }
  return "连接中";
}

function agentColor(id: string): string {
  const colors = ["#0052d9", "#00a870", "#ed7b2f", "#8e56dd", "#d54941", "#6b7785"];
  if (id === "supervisor") return "#0f766e";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_DEFAULT_WIDTH = 292;

export type WorkspaceCreationAction = { kind: "choosePreset" } | { kind: "create" };

export function getWorkspaceCreationAction(presets: readonly WorkspacePreset[]): WorkspaceCreationAction {
  return presets.length > 0 ? { kind: "choosePreset" } : { kind: "create" };
}

export function getConversationRunningLabel(
  summaries: RunningSummary[],
  agents: AgentState[],
  workspaceId: string,
  conversationId: string,
): string | null {
  const summary = summaries.find(
    (r) => r.workspaceId === workspaceId && r.conversationId === conversationId,
  );
  if (!summary?.runningAgentIds.length) {
    return null;
  }

  const labelsById = new Map(agents.map((agent) => [agent.id, agent.label]));
  const labels = [...new Set(summary.runningAgentIds)].map((agentId) => labelsById.get(agentId) ?? agentId);
  return `数字员工正在工作：${labels.join("、")}`;
}

function loadSidebarWidth(): number {
  if (typeof window === "undefined") {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  const stored = window.localStorage.getItem("orbit.sidebarWidth");
  const parsed = stored ? Number(stored) : SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH);
}

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const isSameYear = date.getFullYear() === now.getFullYear();
  const isSameDay = date.toDateString() === now.toDateString();

  if (isSameDay) {
    // 当天：只显示时分
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (isSameYear) {
    // 今年：显示月-日 时:分
    return date.toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  // 跨年：显示年-月-日 时:分
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function getAgentHandoffSummary(
  message: ChatMessage,
  parentMessage: ChatMessage | undefined,
  agentsById: ReadonlyMap<AgentId, Pick<AgentState, "id" | "label">>,
): string | null {
  if (message.kind !== "agent" || !message.parentMessageId) {
    return null;
  }

  const sourceLabel = getHandoffSourceLabel(parentMessage, message.parentMessageId, agentsById);
  const originLabel = parentMessage?.kind === "agent"
    ? "数字员工交接"
    : parentMessage?.kind === "system"
      ? "系统触发"
      : parentMessage?.kind === "user"
        ? "用户指派"
        : "上游消息";
  const parts = [originLabel, `来自 ${sourceLabel}`];

  if (typeof message.routeDepth === "number") {
    parts.push(`第 ${message.routeDepth} 层`);
  }

  return parts.join(" · ");
}

function getHandoffSourceLabel(
  source: ChatMessage | undefined,
  fallbackMessageId: string,
  agentsById: ReadonlyMap<AgentId, Pick<AgentState, "id" | "label">>,
): string {
  if (!source) {
    return `消息 ${formatShortMessageId(fallbackMessageId)}`;
  }

  if (source.kind === "agent") {
    const agentId = source.agentId ?? "agent";
    const label = source.agentId ? agentsById.get(source.agentId)?.label : undefined;
    return `${label ?? agentId} 的消息 ${formatShortMessageId(source.id)}`;
  }

  if (source.kind === "system") {
    return `系统消息 ${formatShortMessageId(source.id)}`;
  }

  return `用户消息 ${formatShortMessageId(source.id)}`;
}

function formatShortMessageId(messageId: string): string {
  const suffix = messageId.includes("_") ? messageId.split("_").at(-1) : messageId.slice(-6);
  return `#${suffix || messageId}`;
}

function scrollMessagesToBottom(element: HTMLDivElement | null): void {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      resolve(base64 || null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 附件 chip 使用的友好大小（B/KB/MB）。 */
function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 剪贴板文本整体是 file:// URI（单行或多行）时视为“复制的文件”，无法作为文本粘贴。 */
function looksLikeFileUrlPaste(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("file://"));
}

function createLocalSystemMessage(content: string): ChatMessage {
  return {
    id: `local_${Date.now()}`,
    kind: "system",
    content,
    createdAt: new Date().toISOString(),
    status: "error",
  };
}

export function mergeOlderMessagesPage(
  current: AppState,
  requestContext: { workspaceId: string; conversationId: string },
  page: MessagePage,
): AppState {
  if (current.workspace.id !== requestContext.workspaceId || current.conversation.id !== requestContext.conversationId) {
    return current;
  }

  const existing = new Set(current.messages.map((message) => message.id));
  const olderMessages = page.messages.filter((message) => !existing.has(message.id));
  return {
    ...current,
    messages: [...olderMessages, ...current.messages],
    messageHistory: {
      hasOlderMessages: page.hasOlderMessages,
      olderCursor: page.olderCursor,
    },
  };
}
