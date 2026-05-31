import { CSSProperties, FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown-renderer.ts";
import { permissionProfile } from "../core/agent-profiles.ts";
import type { AgentActivityEvent, AgentConfig, AgentId, AgentRole, AgentRuntimeKind, AgentState, AppState, ChatMessage, Conversation, ConversationInfo, PermissionProfile, RuntimeEvent, Workspace } from "../shared/types.ts";

const initialState: AppState = {
  workspace: { id: "", name: "", path: "" },
  conversation: { id: "", name: "" },
  agents: [],
  messages: [],
  terminal: {},
};

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [content, setContent] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("pm");
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [isSending, setIsSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showNewMessageHint, setShowNewMessageHint] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState("");
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationName, setEditingConversationName] = useState("");
  const [openWorkspaceMenuId, setOpenWorkspaceMenuId] = useState<string | null>(null);
  const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const isNearBottomRef = useRef(true);

  const isAnyAgentRunning = state.agents.some((a) => a.status === "running");
  const hasWorkspace = Boolean(state.workspace.id);

  const refreshWorkspaces = () => {
    fetch("/api/workspaces").then((r) => r.json()).then(setWorkspaces).catch(() => {});
  };
  const refreshConversations = () => {
    fetch("/api/conversations").then((r) => r.json()).then(setConversations).catch(() => {});
  };
  const refreshState = () => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((nextState: AppState) => setState(normalizeState(nextState)))
      .catch(() => setConnectionState("offline"));
  };

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
    refreshConversations();
  }, [state.workspace.id, state.conversation.id]);

  const agentsById = useMemo(() => new Map(state.agents.map((agent) => [agent.id, agent])), [state.agents]);
  const agentIds = useMemo(() => state.agents.map((agent) => agent.id), [state.agents]);
  const hasEnabledAgent = agentIds.length > 0;
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
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });

      if (!response.ok) {
        throw new Error(`Message request failed: ${response.status}`);
      }

      setContent("");
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
    if (workspaceId === state.workspace.id || isAnyAgentRunning) return;
    const response = await fetch(`/api/workspaces/${workspaceId}/switch`, { method: "POST" });
    if (!response.ok) return;
    refreshWorkspaces();
    refreshConversations();
    refreshState();
  }

  function handleWorkspaceClick(workspaceId: string) {
    if (workspaceId === state.workspace.id) {
      setCollapsedWorkspaceIds((ids) => {
        const next = new Set(ids);
        if (next.has(workspaceId)) {
          next.delete(workspaceId);
        } else {
          next.add(workspaceId);
        }
        return next;
      });
      return;
    }

    switchWorkspace(workspaceId);
  }

  async function createWorkspaceFromDirectoryPicker() {
    setIsPickingDirectory(true);
    try {
      const pickResponse = await fetch("/api/workspaces/pick-directory", { method: "POST" });
      if (!pickResponse.ok) return;
      const result = (await pickResponse.json()) as { path?: string };
      const selectedPath = result.path?.trim();
      if (!selectedPath) return;

      const createResponse = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedPath }),
      });
      if (!createResponse.ok) return;
      const workspace = (await createResponse.json()) as Workspace;
      if (workspace.id) {
        await switchWorkspace(workspace.id);
      }
      refreshWorkspaces();
    } finally {
      setIsPickingDirectory(false);
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
        setCollapsedWorkspaceIds((ids) => {
          const next = new Set(ids);
          next.delete(workspace.id);
          return next;
        });
        refreshWorkspaces();
        refreshConversations();
        refreshState();
      }
    }

  async function switchConversation(conversationId: string) {
    if (conversationId === state.conversation.id || isAnyAgentRunning) return;
    const response = await fetch(`/api/conversations/${conversationId}/switch`, { method: "POST" });
    if (!response.ok) return;
    refreshConversations();
    refreshState();
  }

  async function createConversation() {
    if (!state.workspace.id) return;
    setCollapsedWorkspaceIds((ids) => {
      const next = new Set(ids);
      next.delete(state.workspace.id);
      return next;
    });
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) return;
    refreshConversations();
    refreshState();
  }

  async function renameConversation(conversationId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditingConversationId(null);
      setEditingConversationName("");
      return;
    }
    const response = await fetch(`/api/conversations/${conversationId}`, {
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
    const response = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
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
                const isWorkspaceConversationOpen = isActiveWorkspace && !collapsedWorkspaceIds.has(ws.id);
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
                        <button className="workspaceNameButton" type="button" onClick={() => handleWorkspaceClick(ws.id)} disabled={isAnyAgentRunning && !isActiveWorkspace} title={ws.path}>
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
                      {isActiveWorkspace ? (
                        <button className="rowIconButton persistent" type="button" onClick={createConversation} title="新建会话">
                          <NavIcon kind="edit" />
                        </button>
                      ) : null}
                    </div>
                    {isWorkspaceConversationOpen ? (
                      <div className="navList conversationList">
                        {conversations.map((conv) => (
                          <div className={`conversationRow ${conv.id === state.conversation.id ? "active" : ""}`} key={conv.id}>
                            {editingConversationId === conv.id ? (
                              <form
                                className="rowRenameForm"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  renameConversation(conv.id, editingConversationName);
                                }}
                              >
                                <input
                                  value={editingConversationName}
                                  onChange={(event) => setEditingConversationName(event.target.value)}
                                  onBlur={() => renameConversation(conv.id, editingConversationName)}
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
                              <button type="button" onClick={() => switchConversation(conv.id)} disabled={isAnyAgentRunning} title={conv.name}>
                                <span>{conv.name}</span>
                              </button>
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
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="navSection compactAgents" aria-label="智能体">
          <div className="navSectionHeader">
            <span><NavIcon kind="agents" />智能体</span>
            <button type="button" onClick={() => setShowAgentManager(true)} disabled={!hasWorkspace} title="添加或启用智能体">+</button>
          </div>
          <nav className="agentList" aria-label="选择智能体">
            {agentIds.length === 0 ? (
              <div className="emptyAgentsHint">
                <strong>还没有启用智能体</strong>
                <span>点击右上角 +，启用默认模板或添加自定义智能体。</span>
              </div>
            ) : (
              agentIds.map((agentId) => (
                <AgentButton
                  key={agentId}
                  agent={agentsById.get(agentId) ?? { id: agentId, label: agentId, runtime: "claude-code", status: "idle" }}
                  selected={selectedAgent === agentId}
                  onClick={() => chooseAgent(agentId)}
                />
              ))
            )}
          </nav>
        </section>

        <div className="sidebarFooter">
          <button className="settingsBtn" type="button" onClick={() => setShowSettings(true)} title="智能体设置">
            <NavIcon kind="settings" />
            设置
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

      <section className="channel" aria-label="Chat channel">
        <header className="channelHeader">
          <div className="channelHeaderLeft">
            <p className="eyebrow">{state.workspace.name || "工作区"}</p>
            <h1>{state.conversation.name || (hasWorkspace ? "新会话" : "未选择工作区")}</h1>
            {state.workspace.path ? <p className="workspacePath" title={state.workspace.path}>{state.workspace.path}</p> : null}
          </div>
          <div className="channelHeaderRight">
            <span className="headerMeta">{state.messages.length} 条消息</span>
          </div>
        </header>

        <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-label="消息列表" onScroll={handleMessagesScroll}>
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
                    <li><strong>1</strong> 启用或添加智能体</li>
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

        <form className="composer" onSubmit={sendMessage}>
          <div className="composerInputWrap">
            <textarea
              ref={inputRef}
              value={content}
              rows={1}
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
              placeholder={!hasWorkspace ? "先选择或创建工作区" : hasEnabledAgent ? `@${selectedAgent}: 输入任务` : "先添加或启用智能体"}
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
          <button type="submit" disabled={!hasWorkspace || !hasEnabledAgent || !content.trim() || isSending}>
            {isSending ? <span className="sendSpinner" aria-hidden="true" /> : "发送"}
          </button>
        </form>
      </section>
      {showSettings ? (
        <SystemSettingsPanel
          onClose={() => setShowSettings(false)}
        />
      ) : null}
      {showAgentManager ? (
        <AgentManagerPanel
          onClose={() => setShowAgentManager(false)}
          onSaved={() => { setShowAgentManager(false); window.location.reload(); }}
        />
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

function AgentButton(props: { agent: AgentState; selected: boolean; onClick: () => void }) {
  const isRunning = props.agent.status === "running" || props.agent.status === "starting";
  return (
    <button className={`agentButton ${props.selected ? "selected" : ""} ${isRunning ? "agentRunning" : ""}`} onClick={props.onClick} type="button">
      {isRunning ? <span className="agentProgressBar" aria-hidden="true" /> : null}
      <span className={`statusDot ${props.agent.status}`} aria-hidden="true" />
      <span className="agentText">
        <strong>
          {props.agent.label}
          <RuntimeBadge runtime={props.agent.runtime} />
        </strong>
        <small>{props.agent.id}</small>
      </span>
      <span className={`agentStatusPill ${props.agent.status}`}>{props.agent.status}</span>
    </button>
  );
}

function MessageRow({ message, agent }: { message: ChatMessage; agent?: AgentState }) {
  const author = message.kind === "user" ? "You" : message.kind === "agent" ? message.agentId ?? "agent" : "system";
  const isRunning = message.status === "running";

  return (
    <article className={`message ${message.kind}`}>
      <div className="messageMeta">
        <strong>{author}</strong>
        {message.kind === "agent" && agent ? <RuntimeBadge runtime={agent.runtime} /> : null}
        {message.status ? <span>{message.status}</span> : null}
        <DurationDisplay
          startedAt={message.startedAt ?? (isRunning ? message.createdAt : undefined)}
          completedAt={message.completedAt}
          isRunning={isRunning}
        />
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

const RUNTIMES: AgentRuntimeKind[] = ["claude-code", "codex", "codebuddy"];
const ROLES: AgentRole[] = ["pm", "architect", "developer", "tester", "general"];
const PERM_FLAGS: { key: keyof PermissionProfile; label: string; hint: string }[] = [
  { key: "canReadFiles", label: "读取文件", hint: "允许智能体读取工作区中的文件内容。" },
  { key: "canWriteFiles", label: "写入文件", hint: "允许智能体创建、修改或删除工作区中的文件。" },
  { key: "canRunCommands", label: "运行命令", hint: "允许智能体执行终端命令（如构建、测试等）。" },
  { key: "canInstallDependencies", label: "安装依赖", hint: "允许智能体安装项目依赖包（如 npm install）。" },
  { key: "canGitCommit", label: "Git 提交", hint: "允许智能体执行 git commit 和 git push 操作。" },
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
            <span className="fieldHint" title="限制智能体只能访问指定目录。留空表示允许访问整个工作区。多个目录用逗号分隔。">?</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SystemSettingsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalPanel settingsPlaceholderPanel" onClick={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <h2>系统设置</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        <div className="settingsBody">
          <div className="settingsPlaceholder">
            <strong>暂时没有系统设置项</strong>
            <span>智能体管理已经移动到左侧“智能体”标题右侧的 +。</span>
          </div>
        </div>
        <div className="modalFooter">
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function AgentManagerPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [configs, setConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => { setConfigs(data as AgentConfig[]); setLoading(false); })
      .catch(() => { setError("加载智能体配置失败。"); setLoading(false); });
  }, []);

  function updateConfig(index: number, patch: Partial<AgentConfig>) {
    setConfigs((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addConfig() {
    const newIndex = configs.length;
    setConfigs((prev) => [
      ...prev,
      { id: `agent-${Date.now()}`, name: "", role: "general", runtime: "claude-code", systemPrompt: "", enabled: true },
    ]);
    setExpandedIndex(newIndex);
  }

  function removeConfig(index: number) {
    setConfigs((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
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
          <h2>智能体</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        {loading ? <p className="settingsLoading">加载中...</p> : (
          <div className="settingsBody">
            <div className="agentManagerIntro">
              <strong>默认智能体模板</strong>
              <span>Product Manager、Architect、Developer、Tester 是内置模板，默认不启用。你可以按当前工作区需要开启，也可以创建自己的智能体。</span>
            </div>
            <button type="button" className="addBtn addBtnTop" onClick={addConfig}>+ 添加自定义智能体</button>
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
                    </div>
                    <div className="configCardActions">
                      <button type="button" className="removeBtn" onClick={(e) => { e.stopPropagation(); removeConfig(i); }} title="删除">&times;</button>
                      <span className={`configChevron ${isExpanded ? "configChevronOpen" : ""}`}>▶</span>
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="configCardBody">
                      <div className="configFields">
                        <div className="fieldWithHint">
                          <input placeholder="ID" value={config.id} onChange={(e) => updateConfig(i, { id: e.target.value })} />
                          <span className="fieldHint" title="智能体的唯一标识符，用于 @mention 语法（如 @developer:）。只能用小写字母，不能有空格。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="Name" value={config.name} onChange={(e) => updateConfig(i, { name: e.target.value })} />
                          <span className="fieldHint" title="显示在侧边栏和消息头中的可读名称。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="Display label (optional)" value={config.ui?.label ?? ""} onChange={(e) => updateConfig(i, { ui: { ...config.ui, label: e.target.value || undefined } })} />
                          <span className="fieldHint" title="侧边栏显示的标签，为空则使用 Name 字段。">?</span>
                        </div>
                        <div className="fieldWithHint">
                          <input placeholder="Description" value={config.description ?? ""} onChange={(e) => updateConfig(i, { description: e.target.value })} />
                          <span className="fieldHint" title="智能体能力的简短描述。其他智能体发现可协作成员时会看到此内容。">?</span>
                        </div>
                        <div className="pillGroup">
                          <span className="pillLabel">Role <span className="fieldHint" title="决定默认权限和行为。pm = 规划，architect = 设计，developer = 编码，tester = 测试，general = 自定义。">?</span></span>
                          <div className="pillOptions">
                            {ROLES.map((r) => (
                              <button key={r} type="button" className={`pillBtn ${config.role === r ? "pillActive" : ""}`} onClick={() => updateConfig(i, { role: r })}>{r}</button>
                            ))}
                          </div>
                        </div>
                        <div className="pillGroup">
                          <span className="pillLabel">Runtime <span className="fieldHint" title="驱动该智能体的命令行工具。claude-code = Claude CLI，codex = OpenAI Codex，codebuddy = CodeBuddy CLI。">?</span></span>
                          <div className="pillOptions">
                            {RUNTIMES.map((r) => (
                              <button key={r} type="button" className={`pillBtn ${config.runtime === r ? "pillActive" : ""}`} onClick={() => updateConfig(i, { runtime: r })}>{r}</button>
                            ))}
                          </div>
                        </div>
                        <div className="fieldWithHint fieldFullWidth">
                          <textarea placeholder="System prompt" value={config.systemPrompt} onChange={(e) => updateConfig(i, { systemPrompt: e.target.value })} rows={3} />
                          <span className="fieldHint fieldHintTop" title="每次运行时发送给智能体的指令。定义其角色、专业能力和行为约束。">?</span>
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
    terminal: {
      ...(nextState.terminal ?? {}),
    },
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
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
