import { CSSProperties, FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown-renderer.ts";
import { permissionProfile } from "../core/agent-profiles.ts";
import { AGENT_RUNTIME_PRIORITY, runtimeKindToCliKey, runtimeMeta } from "../core/runtime-meta.ts";
import { matchPreset, PRESET_IDS } from "../core/workspace-presets.ts";
import { hasActiveChannelWatchTriggers, type AgentActivityEvent, type AgentConfig, type AgentId, type AgentRole, type AgentRuntimeKind, type AgentState, type AppState, type ChatMessage, type Conversation, type ConversationInfo, type DraftAttachmentInfo, type MessagePage, type PermissionProfile, type RunningSummary, type RuntimeEvent, type Workspace, type WorkspacePreset, ATTACHMENT_LIMITS } from "../shared/types.ts";

const initialState: AppState = {
  workspace: { id: "", name: "", path: "" },
  conversation: { id: "", name: "" },
  agents: [],
  messages: [],
  messageHistory: { hasOlderMessages: false, olderCursor: null },
  terminal: {},
  runningSummaries: [],
  runtimeAvailability: [],
};

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [content, setContent] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("pm");
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
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<DraftAttachmentInfo[]>([]);
  const [attachmentToast, setAttachmentToast] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<DraftAttachmentInfo | null>(null);
  const [isRefreshingRuntimes, setIsRefreshingRuntimes] = useState(false);
  const isNearBottomRef = useRef(true);

  const isAnyAgentRunning = state.agents.some((a) => a.status === "running");
  const hasAnyQueuedRun = state.messages.some((m) => m.runStatus === "queued");
  const hasRunningOrQueued = isAnyAgentRunning || hasAnyQueuedRun;
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
  const refreshState = () => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((nextState: AppState) => setState(normalizeState(nextState)))
      .catch(() => setConnectionState("offline"));
  };

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

    fetch("/api/state")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`State request failed: ${response.status}`);
        }
        return response.json();
      })
      .then((nextState: AppState) => {
        if (!cancelled) {
          setState(normalizeState(nextState));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionState("offline");
        }
      });

    const events = new EventSource("/events");
    events.onopen = () => setConnectionState("live");
    events.onerror = () => setConnectionState("offline");
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RuntimeEvent;
        if (event.type === "context.switched") {
          // Full state re-fetch on context switch
          fetch("/api/state")
            .then((r) => r.json())
            .then((nextState: AppState) => {
              if (!cancelled) setState(normalizeState(nextState));
            })
            .catch(() => {});
          return;
        }
        setState((current) => applyEvent(current, event));
      } catch {
        setConnectionState("offline");
      }
    };

    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  // Load workspace and conversation lists
  useEffect(() => {
    refreshWorkspaces();
  }, [state.workspace.id, state.conversation.id]);

  // Clear pending attachments when workspace or conversation changes
  // to avoid preview URL pointing to wrong workspace/conversation path
  useEffect(() => {
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

  const agentsById = useMemo(() => new Map(state.agents.map((agent) => [agent.id, agent])), [state.agents]);
  const agentIds = useMemo(() => state.agents.map((agent) => agent.id), [state.agents]);
  const hasEnabledAgent = agentIds.length > 0;
  const hasCoordinator = useMemo(() => state.agents.some((agent) => agent.role === "coordinator" && hasActiveChannelWatchTriggers(agent.triggers)), [state.agents]);
  const scrollKey = useMemo(
    () =>
      state.messages
        .map((message) =>
          [
            message.id,
            message.status ?? "",
            message.content.length,
            message.activity?.length ?? 0,
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
    const matched = agentIds.filter((agentId) => agentId.toLowerCase().startsWith(query));
    if ("all".startsWith(query) && !matched.includes("all")) {
      matched.push("all" as AgentId);
    }
    return matched;
  }, [agentIds, inputFocused, mentionDraft]);

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

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || isSending) {
      return;
    }

    setIsSending(true);
    try {
      const body: { content: string; draftAttachments?: Array<{ id: string; mimeType: string; filename: string; size: number }> } = {
        content: trimmed,
      };
      if (pendingAttachments.length > 0) {
        body.draftAttachments = pendingAttachments.map((a) => ({
          id: a.id,
          mimeType: a.mimeType,
          filename: a.filename,
          size: a.size,
        }));
      }
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Message request failed: ${response.status}`);
      }

      setContent("");
      setPendingAttachments([]);
      isNearBottomRef.current = true;
      setIsNearBottom(true);
      setShowNewMessageHint(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } catch {
      setState((current) => ({
        ...current,
        messages: [...current.messages, createLocalSystemMessage("发送失败，请检查本地服务是否正在运行。")],
      }));
    } finally {
      setIsSending(false);
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;

    // Prevent default to avoid the image being pasted as text; images are handled separately
    event.preventDefault();

    const maxFiles = ATTACHMENT_LIMITS.MAX_FILES_PER_MESSAGE;
    if (pendingAttachments.length + imageFiles.length > maxFiles) {
      setAttachmentToast(`最多只能添加 ${maxFiles} 张图片`);
      window.setTimeout(() => setAttachmentToast(null), 3000);
      return;
    }

    for (const file of imageFiles.slice(0, maxFiles - pendingAttachments.length)) {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];
        if (!base64) return;

        try {
          const response = await fetch("/api/attachments/drafts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              data: base64,
              mimeType: file.type,
              filename: file.name || "pasted-image.png",
            }),
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            setAttachmentToast((err as { message?: string }).message ?? "图片上传失败");
            window.setTimeout(() => setAttachmentToast(null), 3000);
            return;
          }
          const result = await response.json();
          if (result.ok && result.attachment) {
            setPendingAttachments((prev) => [...prev, result.attachment as DraftAttachmentInfo]);
          }
        } catch {
          setAttachmentToast("图片上传失败");
          window.setTimeout(() => setAttachmentToast(null), 3000);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  async function removePendingAttachment(id: string) {
    try {
      await fetch(`/api/attachments/drafts/${state.workspace.id}/${state.conversation.id}/${id}`, {
        method: "DELETE",
      });
    } catch { /* best effort */ }
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function interruptChain() {
    if (isInterrupting) return;
    setIsInterrupting(true);
    try {
      const response = await fetch("/api/conversation/interrupt", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Interrupt request failed: ${response.status}`);
      }
      const data = await response.json();
      if ((data.cancelledQueuedRunIds?.length ?? 0) > 0 || (data.suppressedRunningRunIds?.length ?? 0) > 0) {
        setInterruptToast("已打断后续自动协作");
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
      const response = await fetch(`/api/messages?before=${encodeURIComponent(cursor)}&limit=50`);
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
    setSelectedAgent(agentId);
    setContent((current) => {
      if (!current.trim() || /^@\w[\w-]*:\s*$/.test(current.trim())) {
        return `@${agentId}: `;
      }
      return current;
    });
    const nextCursorIndex = agentId.length + 3;
    setCursorIndex(nextCursorIndex);
    window.setTimeout(() => {
      inputRef.current?.focus();
      if (!content.trim() || /^@\w[\w-]*:\s*$/.test(content.trim())) {
        inputRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
      }
    }, 0);
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === state.workspace.id) return;
    const response = await fetch(`/api/workspaces/${workspaceId}/switch`, { method: "POST" });
    if (!response.ok) return;
    refreshWorkspaces();
    refreshConversations();
    refreshState();
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
      if (response.ok) {
        setOpenWorkspaceMenuId(null);
        setExpandedWorkspaceIds((ids) => {
          const next = new Set(ids);
          next.delete(workspace.id);
          return next;
        });
        refreshWorkspaces();
        refreshConversations();
        refreshState();
      }
    }

  async function switchConversation(conversationId: string, targetWorkspaceId?: string) {
    if (conversationId === state.conversation.id) return;
    const wsParam = targetWorkspaceId && targetWorkspaceId !== state.workspace.id ? `?workspaceId=${targetWorkspaceId}` : "";
    const response = await fetch(`/api/conversations/${conversationId}/switch${wsParam}`, { method: "POST" });
    if (!response.ok) return;
    refreshConversations();
    refreshState();
  }

  async function createConversation(workspaceId: string) {
    const wsParam = workspaceId !== state.workspace.id ? `?workspaceId=${workspaceId}` : "";
    const response = await fetch(`/api/conversations${wsParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) return;
    // Expand the workspace so user sees the new conversation
    setExpandedWorkspaceIds((ids) => {
      const next = new Set(ids);
      next.add(workspaceId);
      return next;
    });
    refreshConversations();
    refreshState();
  }

  async function renameConversation(conversationId: string, name: string, workspaceId?: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingConversationId(null);
      setEditingConversationName("");
      return;
    }
    const wsParam = workspaceId && workspaceId !== state.workspace.id ? `?workspaceId=${workspaceId}` : "";
    const response = await fetch(`/api/conversations/${conversationId}${wsParam}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!response.ok) return;
    setEditingConversationId(null);
    setEditingConversationName("");
    refreshConversations();
    refreshState();
  }

  async function deleteConversation(conversation: Conversation) {
    if (!confirm(`Delete conversation "${conversation.name}"?`)) return;
    const response = await fetch(`/api/conversations/${conversation.id}?workspaceId=${conversation.workspaceId}`, { method: "DELETE" });
    if (response.ok) {
      setOpenConversationMenuId(null);
      refreshConversations();
      refreshState();
    }
  }

  function updateCursorFromInput() {
    setCursorIndex(inputRef.current?.selectionStart ?? content.length);
  }

  function chooseMention(agentId: AgentId) {
    if (!mentionDraft) {
      return;
    }

    const nextContent = `${content.slice(0, mentionDraft.start)}@${agentId}: ${content.slice(mentionDraft.end)}`;
    const nextCursorIndex = mentionDraft.start + agentId.length + 3;
    if (agentId !== "all") {
      setSelectedAgent(agentId);
    }
    setContent(nextContent);
    setCursorIndex(nextCursorIndex);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCursorIndex, nextCursorIndex);
    }, 0);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
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
            <div className="brandMark">orbit</div>
            <div className={`connection ${connectionState}`}>{connectionLabel(connectionState)}</div>
            <button className="sidebarCollapseBtn" type="button" onClick={() => setSidebarCollapsed(true)} title="隐藏侧边栏">
              <NavIcon kind="collapse" />
            </button>
          </div>
        </div>

        <section className="navSection workspaceStack" aria-label="当前工作区和会话">
          <div className="navSectionHeader">
            <span>工作区</span>
            <button type="button" onClick={createWorkspaceFromDirectoryPicker} disabled={isPickingDirectory} title="新建工作区">+</button>
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
                          <NavIcon kind="workspace" />
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
                          <NavIcon kind="edit" />
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

        <section className="navSection compactAgents" aria-label="数字员工">
          <div className="navSectionHeader">
            <span><NavIcon kind="agents" />数字员工</span>
            <button type="button" onClick={() => setShowAgentManager(true)} disabled={!hasWorkspace} title="添加或启用数字员工">+</button>
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
                  agent={agentsById.get(agentId) ?? { id: agentId, label: agentId, runtime: "claude-code", role: "general", status: "idle" }}
                  selected={selectedAgent === agentId}
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
            className="sidebarSettingsBtn"
            onClick={() => setShowSettings(true)}
            title="设置"
          >
            ⚙️
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
        <NavIcon kind="expand" />
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

      <section className="conversation" aria-label="Chat conversation">
        <header className={`conversationHeader ${headerCollapsed ? "collapsed" : ""}`}>
          {headerCollapsed ? (
            <div className="conversationHeaderLeft">
              {state.workspace.name ? <p className="eyebrow">{state.workspace.name}</p> : null}
              <h1 title={state.conversation.name || (hasWorkspace ? "新会话" : "未选择工作区")}>
                {state.conversation.name || (hasWorkspace ? "新会话" : "未选择工作区")}
              </h1>
            </div>
          ) : (
            <div className="conversationHeaderLeft">
              <p className="eyebrow">{state.workspace.name || "工作区"}</p>
              <h1>{state.conversation.name || (hasWorkspace ? "新会话" : "未选择工作区")}</h1>
              {state.workspace.path ? <p className="workspacePath" title={state.workspace.path}>{state.workspace.path}</p> : null}
            </div>
          )}
          <div className="conversationHeaderRight">
            {!headerCollapsed && <span className="headerMeta">{state.messages.length} 条消息</span>}
            <button
              className="headerCollapseBtn"
              type="button"
              onClick={() => setHeaderCollapsed((c) => !c)}
              title={headerCollapsed ? "展开头部" : "折叠头部"}
            >
              <NavIcon kind="collapse" />
            </button>
          </div>
        </header>

        <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-label="消息列表" onScroll={handleMessagesScroll}>
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
          {state.messages.length === 0 ? (
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
                    <li><strong>2</strong> 使用 <code>@agent:</code> 输入任务</li>
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
            state.messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                agent={message.agentId ? agentsById.get(message.agentId) : undefined}
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
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 12V4m0 0L4 8m4-4l4 4" /></svg>
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
        <form className="composer" onSubmit={sendMessage}>
          <div className={`composerInputWrap${pendingAttachments.length > 0 ? " hasAttachments" : ""}`}>
            {pendingAttachments.length > 0 && (
              <div className="attachmentPreviewBar">
                {pendingAttachments.map((att) => (
                  <div key={att.id} className="attachmentPreviewItem">
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
                  </div>
                ))}
              </div>
            )}
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
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage(event as unknown as FormEvent<HTMLFormElement>);
                  return;
                }
                handleComposerKeyDown(event as unknown as KeyboardEvent<HTMLInputElement>);
              }}
              onKeyUp={updateCursorFromInput}
              placeholder={!hasWorkspace ? "先选择或创建工作区" : hasCoordinator ? "直接输入消息，或使用 @developer: 指派具体数字员工" : hasEnabledAgent ? `@${selectedAgent}: 输入任务` : "先添加或启用数字员工"}
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
          </div>
          <div className="composerActions">
            {hasRunningOrQueued ? (
              <button
                type="button"
                className="interruptBtn"
                onClick={interruptChain}
                disabled={isInterrupting}
                title="停止后续自动协作"
              >
                {isInterrupting ? <span className="sendSpinner" aria-hidden="true" /> : "打断"}
              </button>
            ) : null}
            <button type="submit" disabled={!hasWorkspace || !hasEnabledAgent || !content.trim() || isSending}>
              {isSending ? <span className="sendSpinner" aria-hidden="true" /> : "发送"}
            </button>
          </div>
        </form>
      </section>
      {showSettings ? (
        <SystemSettingsPanel
          onClose={() => setShowSettings(false)}
        />
      ) : null}
      {showWorkspaceConfig ? (
        <WorkspaceConfigPanel
          onClose={() => setShowWorkspaceConfig(false)}
          hasWorkspace={hasWorkspace}
          presets={workspacePresets}
        />
      ) : null}
      {pendingWorkspacePath ? (
        <div className="modalOverlay" onClick={() => setPendingWorkspacePath(null)}>
          <div className="modalPanel presetPickerPanel" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <h2>选择工作区模板</h2>
              <button type="button" onClick={() => setPendingWorkspacePath(null)}>&times;</button>
            </div>
            <div className="settingsBody">
              <span className="workspaceConfigHint">选择一个内置模板快速配置工作区，或使用空白工作区。</span>
              <div className="presetPickerList">
                {workspacePresets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    runtimeAvailability={state.runtimeAvailability}
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
          focusedAgentId={focusedAgentId}
          onClose={() => { setShowAgentManager(false); setFocusedAgentId(null); }}
          onSaved={() => { setShowAgentManager(false); setFocusedAgentId(null); window.location.reload(); }}
          runtimeAvailability={state.runtimeAvailability}
          isRefreshingRuntimes={isRefreshingRuntimes}
          onRefreshRuntimes={refreshRuntimeAvailability}
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

function MentionMenu(props: {
  agentsById: Map<AgentId, AgentState>;
  candidates: AgentId[];
  selectedIndex: number;
  onSelect: (agentId: AgentId) => void;
}) {
  return (
    <div className="mentionMenu" role="listbox" aria-label="Choose agent">
      {props.candidates.map((agentId, index) => {
        const isAll = agentId === "all";
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
              <span className={`mentionDot ${isAll ? "idle" : status}`} aria-hidden="true" />
              <span>@{agentId}</span>
            </span>
            <small>{isAll ? "all agents" : status}</small>
          </button>
        );
      })}
      <div className="mentionHint">↑↓ select · Tab/Enter confirm · Esc close</div>
    </div>
  );
}

function NavIcon({ kind }: { kind: "workspace" | "conversation" | "agents" | "settings" | "collapse" | "expand" | "edit" }) {
  if (kind === "workspace") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.5 4.5h3l1.1 1.4h6.9v5.6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 11.5v-7Z" />
      </svg>
    );
  }
  if (kind === "conversation") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 4.5A2 2 0 0 1 5 2.5h6A2 2 0 0 1 13 4.5v4A2 2 0 0 1 11 10.5H7L4 13v-2.6A2 2 0 0 1 3 8.5v-4Z" />
      </svg>
    );
  }
  if (kind === "agents") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.2a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z" />
        <path d="M3.8 13a4.2 4.2 0 0 1 8.4 0" />
      </svg>
    );
  }
  if (kind === "collapse") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M10 3 5 8l5 5" />
      </svg>
    );
  }
  if (kind === "expand") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 3l5 5-5 5" />
      </svg>
    );
  }
  if (kind === "edit") {
    return (
      <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 11.5V13h1.5l7-7L10 4.5l-7 7Z" />
        <path d="M9.5 5 11 3.5 12.5 5 11 6.5" />
      </svg>
    );
  }
  return (
    <svg className="navIcon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
      <path d="M8 1.8v1.4M8 12.8v1.4M3.6 3.6l1 1M11.4 11.4l1 1M1.8 8h1.4M12.8 8h1.4M3.6 12.4l1-1M11.4 4.6l1-1" />
    </svg>
  );
}

function AgentButton(props: { agent: AgentState; selected: boolean; onClick: () => void; onConfig?: () => void }) {
  const isRunning = props.agent.status === "running" || props.agent.status === "starting";
  const isRuntimeMissing = props.agent.runtimeAvailable === false;
  const meta = runtimeMeta(props.agent.runtime);
  return (
    <button
      className={`agentButton ${props.selected && !isRunning ? "selected" : ""} ${isRunning ? "agentRunning" : ""} ${isRuntimeMissing ? "agentRuntimeMissing" : ""}`}
      onClick={props.onClick}
      type="button"
      title={isRuntimeMissing ? `${meta.label} 未安装，该数字员工无法运行` : undefined}
    >
      <span className={`statusDot ${isRuntimeMissing ? "runtimeMissing" : props.agent.status}`} aria-hidden="true" />
      <span className="agentText">
        <span className="agentTextRow">
          <strong>
            {props.agent.label}
            {isRunning && <span className="agentRunningLabel">Running</span>}
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
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 1.5l3 3L5 14H2v-3z" />
                <path d="M9.5 3.5l3 3" />
              </svg>
            </span>
          )}
        </span>
        <small>
          {props.agent.id}
          {isRuntimeMissing ? (
            <>
              {" · "}<a href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="agentInstallLink" onClick={(e) => e.stopPropagation()}>安装 ↗</a>
            </>
          ) : null}
        </small>
      </span>
      <span className={`agentStatusPill ${isRuntimeMissing ? "runtimeMissing" : props.agent.status}`}>
        {isRuntimeMissing ? "missing" : props.agent.status}
      </span>
    </button>
  );
}

function MessageRow({ message, agent }: { message: ChatMessage; agent?: AgentState }) {
  const author = message.kind === "user" ? "You" : message.kind === "agent" ? message.agentId ?? "agent" : "system";
  const isRunning = message.status === "running";
  const isQueued = message.runStatus === "queued";
  const [cancelling, setCancelling] = useState(false);

  async function cancelRun() {
    if (!message.runId || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/runs/${message.runId}/cancel`, { method: "POST" });
    } catch {
      // Cancellation request failed silently — the run may already be done
    } finally {
      setCancelling(false);
    }
  }

  return (
    <article className={`message ${message.kind}`}>
      <div className="messageMeta">
        <strong>{author}</strong>
        {message.kind === "agent" && agent ? <RuntimeBadge runtime={agent.runtime} /> : null}
        {message.status ? <span className={`statusPill ${message.status}`}>{message.status}</span> : null}
        {((isQueued || isRunning) && message.runId) || cancelling ? (
          <button
            type="button"
            className="cancelRunBtn"
            onClick={cancelRun}
            disabled={cancelling}
            title={cancelling ? "正在取消..." : isRunning ? "打断正在执行的任务" : "取消排队任务"}
          >
            {cancelling ? "取消中..." : isRunning ? "打断" : "取消"}
          </button>
        ) : null}
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
      </div>
      {message.sessionId || message.runIndex ? (
        <div className="sessionInfo">
          {message.sessionId ? (
            <span>session: {message.sessionId}</span>
          ) : null}
          {message.runIndex ? <span>run #{message.runIndex}</span> : null}
        </div>
      ) : null}
      <div className="messageBody">
        {message.activity?.length ? <ActivityList activity={message.activity} status={message.status} /> : null}
        {message.kind === "agent" ? <MarkdownContent content={message.content} /> : <PlainText content={message.content} />}
        {message.attachments?.length ? (
          <div className="messageAttachments">
            {message.attachments.map((att) => (
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
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
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

function ActivityList({ activity, status }: { activity: AgentActivityEvent[]; status?: ChatMessage["status"] }) {
  const shouldAutoCollapse = status === "done" || status === "error";
  const [manualOverride, setManualOverride] = useState(false);
  const [expanded, setExpanded] = useState(!shouldAutoCollapse);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const toolCount = activity.filter((item) => item.type === "tool.started").length;
  const failedCount = activity.filter((item) => item.type === "tool.failed").length;
  const errorCount = activity.filter((item) => item.type === "error").length;
  const latest = activity[activity.length - 1];
  const visibleActivity = expanded ? activity : activity.slice(-3);

  useEffect(() => {
    if (!manualOverride) {
      setExpanded(!shouldAutoCollapse);
    }
  }, [manualOverride, shouldAutoCollapse]);

  useEffect(() => {
    if (expanded) {
      timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
    }
  }, [activity.length, expanded]);

  function toggleExpanded() {
    setManualOverride(true);
    setExpanded((value) => !value);
  }

  return (
    <div className={`activityPanel ${expanded ? "expanded" : "collapsed"}`} aria-label="Agent activity">
      <div className="activityHeader">
        <div className="activitySummary">
          <strong>Activity</strong>
          <span>{activity.length} events</span>
          {toolCount > 0 ? <span>{toolCount} tools</span> : null}
          {failedCount > 0 ? <span className="activityErrorCount">{failedCount} failed</span> : null}
          {errorCount > 0 ? <span className="activityErrorCount">{errorCount} errors</span> : null}
        </div>
        {activity.length > 3 ? (
          <button type="button" onClick={toggleExpanded}>
            {expanded ? "Collapse" : "Show full"}
          </button>
        ) : null}
      </div>
      {latest ? <div className="activityLatest">{activityText(latest)}</div> : null}
      <div className="activityTimeline" ref={timelineRef}>
        {visibleActivity.map((item, index) => (
          <div className={`activityItem ${item.type.replace(".", "-")}`} key={`${item.timestamp}_${index}`}>
            <span className="activityDot" aria-hidden="true" />
            <span className="activityText">{activityText(item)}</span>
            <time>{formatTime(item.timestamp)}</time>
          </div>
        ))}
      </div>
    </div>
  );
}

const RUNTIMES: readonly AgentRuntimeKind[] = AGENT_RUNTIME_PRIORITY;
const ROLES: AgentRole[] = ["pm", "architect", "developer", "tester", "general", "coordinator"];
const PERM_FLAGS: { key: keyof PermissionProfile; label: string; hint: string }[] = [
  { key: "canReadFiles", label: "读取文件", hint: "允许数字员工读取工作区中的文件内容。" },
  { key: "canWriteFiles", label: "写入文件", hint: "允许数字员工创建、修改或删除工作区中的文件。" },
  { key: "canRunCommands", label: "运行命令", hint: "允许数字员工执行终端命令（如构建、测试等）。" },
  { key: "canInstallDependencies", label: "安装依赖", hint: "允许数字员工安装项目依赖包（如 npm install）。" },
  { key: "canGitCommit", label: "Git 提交", hint: "允许数字员工执行 git commit 和 git push 操作。" },
];

function PermissionEditor({ config, onChange }: { config: AgentConfig; onChange: (pp: PermissionProfile) => void }) {
  const [expanded, setExpanded] = useState(false);
  const pp: PermissionProfile = config.permissionProfile ?? permissionProfile(config.role);

  return (
    <div className="permSection">
      <button type="button" className="permToggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "▼" : "▶"} 权限设置
      </button>
      {expanded ? (
        <div className="permFields">
          {PERM_FLAGS.map(({ key, label, hint }) => (
            <label key={key} className="permLabel">
              <input type="checkbox" checked={pp[key] as boolean} onChange={(e) => onChange({ ...pp, [key]: e.target.checked })} /> {label}
              <span className="fieldHint" title={hint}>?</span>
            </label>
          ))}
          <div className="fieldWithHint">
            <input
              placeholder="允许访问的目录（逗号分隔）"
              value={pp.allowedDirectories.join(", ")}
              onChange={(e) => onChange({ ...pp, allowedDirectories: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
            <span className="fieldHint" title="限制数字员工只能访问指定目录。留空表示允许访问整个工作区。多个目录用逗号分隔。">?</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

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
function PresetCard({ preset, selected, runtimeAvailability, onClick }: { preset: WorkspacePreset; selected?: boolean; runtimeAvailability?: AppState["runtimeAvailability"]; onClick: () => void }) {
  const classes = [
    "presetCard",
    selected ? "presetCardSelected" : "",
    preset.recommended ? "presetCardRecommended" : "",
  ].filter(Boolean).join(" ");
  const runtimeSummary = runtimeAvailability && preset.id === PRESET_IDS.multiAgentCollaboration
    ? summarizeRuntimeAvailability(runtimeAvailability)
    : null;
  return (
    <button type="button" className={classes} aria-pressed={selected} onClick={onClick}>
      <span className="presetName">{preset.name}</span>
      <span className="presetDesc">{preset.description}</span>
      {runtimeSummary ? <span className={`presetRuntimeHint ${runtimeSummary.kind}`}>{runtimeSummary.text}</span> : null}
      {preset.recommended ? <span className="presetBadge">推荐</span> : null}
    </button>
  );
}

function summarizeRuntimeAvailability(availability: AppState["runtimeAvailability"]): { kind: "ready" | "missing"; text: string } {
  const available = RUNTIMES
    .filter((runtime) => availability.some((item) => item.runtime === runtimeKindToCliKey(runtime) && item.available))
    .map((runtime) => runtimeMeta(runtime).label);
  if (available.length > 0) {
    return { kind: "ready", text: `将默认使用：${available[0]}` };
  }
  return { kind: "missing", text: "未检测到运行时，创建后可按提示安装" };
}

// Workspace-level config - prompt and rules
function WorkspaceConfigPanel({ onClose, hasWorkspace, presets }: { onClose: () => void; hasWorkspace: boolean; presets: WorkspacePreset[] }) {
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
    fetch("/api/workspace-config")
      .then((r) => r.json())
      .then((cfg: { systemPrompt?: string; rules?: string[] }) => {
        setSystemPrompt(cfg.systemPrompt ?? "");
        setRules(cfg.rules ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [hasWorkspace]);

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
    fetch("/api/workspace-config", {
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
                  <span className="workspaceConfigHint">选择内置模板一键填充提示词和规则，会覆盖当前内容。</span>
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
  onSaved,
  runtimeAvailability,
  focusedAgentId,
  isRefreshingRuntimes,
  onRefreshRuntimes,
}: {
  onClose: () => void;
  onSaved: () => void;
  runtimeAvailability: AppState["runtimeAvailability"];
  focusedAgentId?: string | null;
  isRefreshingRuntimes: boolean;
  onRefreshRuntimes: () => void;
}) {
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
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
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => { setConfigs(data as AgentConfig[]); setLoading(false); })
      .catch(() => { setError("加载数字员工配置失败。"); setLoading(false); });
  }, []);

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
    const role: AgentRole = "general";
    setConfigs((prev) => [
      {
        id: `agent-${Date.now()}`,
        name: "",
        role,
        runtime: firstAvailableRuntime,
        systemPrompt: "",
        enabled: true,
        permissionProfile: permissionProfile(role),
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
    const copy: AgentConfig = {
      ...structuredClone(source),
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
      const res = await fetch("/api/agents", {
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
      const res = await fetch("/api/agents/reset", { method: "POST" });
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

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>数字员工</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        {loading ? <p className="settingsLoading">加载中...</p> : (
          <div className="settingsBody">
            <div className="agentManagerIntro">
              <strong>默认数字员工模板</strong>
              <span>五个内置模板默认不启用。产品经理（pm）、架构师（architect）、开发（developer）、测试（tester）负责规划与实现，监督者（supervisor）负责会话监督与任务闭环。你可以按当前工作区需要开启，也可以创建自己的数字员工。</span>
            </div>
            <div className="runtimeProbeRow">
              <span>安装或更新命令行工具后，可以重新检测运行环境。</span>
              <button type="button" className="runtimeRefreshBtn" onClick={onRefreshRuntimes} disabled={isRefreshingRuntimes}>
                {isRefreshingRuntimes ? "检测中..." : "重新检测运行环境"}
              </button>
            </div>
            <button type="button" className="addBtn addBtnTop" onClick={addConfig}>+ 添加自定义数字员工</button>
            {configs.map((config, i) => {
              const isExpanded = expandedIndex === i;
              return (
                <div key={`config-${i}`} className={`configCard ${isExpanded ? "configCardExpanded" : ""} ${!config.enabled ? "configCardDisabled" : ""}`}>
                  <div className="configCardHeader" onClick={() => setExpandedIndex(isExpanded ? null : i)}>
                    <div className="configCardSummary">
                      <label className="toggleSwitch" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={config.enabled} onChange={() => updateConfig(i, { enabled: !config.enabled })} />
                        <span className="toggleTrack" />
                      </label>
                      <span className="configCardName">{config.name || config.id}</span>
                      <span className="configCardPill configCardRole">{config.role}</span>
                      <span className="configCardPill configCardRuntime">{config.runtime}</span>
                      {hasActiveChannelWatchTriggers(config.triggers) && config.role === "coordinator" ? <span className="configCardPill supervisorBadge">👁 监督</span> : null}
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
                          <input placeholder="标识符" value={config.id} onChange={(e) => updateConfig(i, { id: e.target.value })} />
                          <span className="fieldHint" title="数字员工的唯一标识符，用于 @mention 语法（如 @developer:）。只能用小写字母，不能有空格。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="名称" value={config.name} onChange={(e) => updateConfig(i, { name: e.target.value })} />
                          <span className="fieldHint" title="显示在侧边栏和消息头中的可读名称。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="显示标签（可选）" value={config.ui?.label ?? ""} onChange={(e) => updateConfig(i, { ui: { ...config.ui, label: e.target.value || undefined } })} />
                          <span className="fieldHint" title="侧边栏显示的标签，为空则使用名称字段。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="描述" value={config.description ?? ""} onChange={(e) => updateConfig(i, { description: e.target.value })} />
                          <span className="fieldHint" title="数字员工能力的简短描述。其他数字员工发现可协作成员时会看到此内容。">?</span>
                        </div>
                        <div className="pillGroup">
                          <span className="pillLabel">角色 <span className="fieldHint" title="决定默认权限和行为。pm = 规划，architect = 设计，developer = 编码，tester = 测试，general = 自定义，coordinator = 纯协调/监督。">?</span></span>
                          <div className="pillOptions">
                            {ROLES.map((r) => (
                              <button
                                key={r}
                                type="button"
                                className={`pillBtn ${config.role === r ? "pillActive" : ""}`}
                                onClick={() => {
                                  if (config.role === r) return;
                                  updateConfig(i, { role: r, permissionProfile: permissionProfile(r) });
                                }}
                              >
                                {r}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="pillGroup">
                          <span className="pillLabel">运行时 <span className="fieldHint" title="驱动该数字员工的命令行工具。claude-code = Claude CLI，codex = OpenAI Codex，codebuddy = CodeBuddy CLI。">?</span></span>
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
                                <code className="runtimeInstallCommand">{meta.installCommand}</code>
                                <a href={meta.installUrl} target="_blank" rel="noopener noreferrer" className="runtimeInstallBtn">查看安装指南 ↗</a>
                                <button type="button" className="runtimeRefreshBtn" onClick={onRefreshRuntimes} disabled={isRefreshingRuntimes}>
                                  {isRefreshingRuntimes ? "检测中..." : "重新检测"}
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                        {hasActiveChannelWatchTriggers(config.triggers) && config.role === "coordinator" ? (
                          <SupervisorBanner
                            maxTriggers={config.triggers?.maxTriggersPerConversation ?? 5}
                            hasUnassigned={config.triggers?.onUnassignedMessage === true}
                            hasBlocked={config.triggers?.onAgentBlocked === true}
                            hasRunFailed={config.triggers?.onRunFailed === true}
                          />
                        ) : null}
                        <div className="fieldWithHint fieldFullWidth">
                          <textarea placeholder="系统提示词" value={config.systemPrompt} onChange={(e) => updateConfig(i, { systemPrompt: e.target.value })} rows={3} />
                          <span className="fieldHint fieldHintTop" title="每次运行时发送给数字员工的指令。定义其角色、专业能力和行为约束。">?</span>
                        </div>
                        <PermissionEditor config={config} onChange={(pp) => updateConfig(i, { permissionProfile: pp })} />
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

function SupervisorBanner({ maxTriggers, hasUnassigned, hasBlocked, hasRunFailed }: { maxTriggers: number; hasUnassigned: boolean; hasBlocked: boolean; hasRunFailed: boolean }) {
  return (
    <div className="supervisorBanner">
      <p><span aria-hidden="true">🔍</span> <strong>会话监督已启用</strong></p>
      <p>此数字员工会在以下情况自动介入：</p>
      <ul>
        {hasUnassigned ? (
          <li><span aria-hidden="true">⚡</span> <strong>消息未分配</strong> — 消息中没有 @agent: 标记时，自动分析需求并分配任务</li>
        ) : null}
        {hasBlocked ? (
          <li><span aria-hidden="true">⚡</span> <strong>路由阻塞</strong> — 其他数字员工的消息被路由拒绝时，介入兜底处理</li>
        ) : null}
        {hasRunFailed ? (
          <li><span aria-hidden="true">⚡</span> <strong>运行失败</strong> — 数字员工运行出错时，介入判断下一步处理方式</li>
        ) : null}
      </ul>
      <p>⏱ 单轮对话最多自动触发 {maxTriggers} 次，或在任务闭环后自动停止。关闭启用开关可暂停监督。</p>
    </div>
  );
}

function activityText(item: AgentActivityEvent): string {
  if (item.type === "tool.started") {
    return item.input ? `Started ${item.name}: ${item.input}` : `Started ${item.name}`;
  }
  if (item.type === "tool.completed") {
    if (item.name === "tool") {
      return item.summary ? `Completed: ${item.summary}` : "Completed";
    }
    return item.summary ? `Completed ${item.name}: ${item.summary}` : `Completed ${item.name}`;
  }
  if (item.type === "tool.failed") {
    return item.summary ? `Failed ${item.name}: ${item.summary}` : `Failed ${item.name}`;
  }
  if (item.type === "error") {
    return item.message;
  }
  return item.text;
}

function MarkdownContent({ content }: { content: string }) {
  const html = renderMarkdown(content);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PlainText({ content }: { content: string }) {
  return <div className="plainText">{content}</div>;
}

function applyEvent(state: AppState, event: RuntimeEvent): AppState {
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

  // For conversation-scoped events, only process if they match the active conversation
  if ("conversationId" in event && event.conversationId !== state.conversation.id) {
    return state;
  }

  if (event.type === "message.created") {
    return upsertMessage(state, event.message);
  }

  if (event.type === "message.updated") {
    return upsertMessage(state, event.message);
  }

  if (event.type === "agent.status") {
    return {
      ...state,
      agents: state.agents.map((agent) => (agent.id === event.agentId ? { ...agent, status: event.status } : agent)),
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
        return { ...message, activity: [...(message.activity ?? []), event.activity] };
      }),
    };
  }

  return state;
}

function upsertMessage(state: AppState, nextMessage: ChatMessage): AppState {
  const index = state.messages.findIndex((message) => message.id === nextMessage.id);
  if (index === -1) {
    return { ...state, messages: [...state.messages, nextMessage] };
  }

  return {
    ...state,
    messages: state.messages.map((message) => (message.id === nextMessage.id ? nextMessage : message)),
  };
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
  const match = /(^|\s)@([a-zA-Z0-9_]*)$/.exec(beforeCursor);
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
    return "live";
  }
  if (state === "offline") {
    return "offline";
  }
  return "connecting";
}

const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_DEFAULT_WIDTH = 336;

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

function scrollMessagesToBottom(element: HTMLDivElement | null): void {
  if (!element) {
    return;
  }

  element.scrollTop = element.scrollHeight;
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
