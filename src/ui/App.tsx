import { FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown-renderer.ts";
import { permissionProfile } from "../core/agent-profiles.ts";
import type { AgentActivityEvent, AgentConfig, AgentId, AgentRole, AgentRuntimeKind, AgentState, AppState, ChatMessage, PermissionProfile, RuntimeEvent } from "../shared/types.ts";

const initialState: AppState = {
  workspace: { id: "", name: "orbit", path: "" },
  agents: [
    { id: "pm", label: "Product Manager", runtime: "codex", status: "starting", selected: true },
    { id: "architect", label: "Architect", runtime: "codex", status: "starting", selected: false },
    { id: "developer", label: "Developer", runtime: "claude-code", status: "starting", selected: false },
    { id: "tester", label: "Tester", runtime: "codebuddy", status: "starting", selected: false },
  ],
  messages: [],
  terminal: {},
};

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [content, setContent] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>(initialState.agents[0].id);
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
  const isNearBottomRef = useRef(true);

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

  const agentsById = useMemo(() => new Map(state.agents.map((agent) => [agent.id, agent])), [state.agents]);
  const agentIds = useMemo(() => state.agents.map((agent) => agent.id), [state.agents]);
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
    setSelectedMentionIndex(0);
  }, [mentionDraft?.query]);

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
        messages: [...current.messages, createLocalSystemMessage("Send failed. Check that the local server is running.")],
      }));
    } finally {
      setIsSending(false);
    }
  }

  function chooseAgent(agentId: AgentId) {
    setSelectedAgent(agentId);
    window.setTimeout(() => inputRef.current?.focus(), 0);
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
    <main className="shell">
      <aside className="sidebar" aria-label="Agent status">
        <div className="brandBlock">
          <div className="brandMark">orbit</div>
          <div className={`connection ${connectionState}`}>{connectionLabel(connectionState)}</div>
        </div>

        <nav className="agentList" aria-label="Choose agent">
          {agentIds.map((agentId) => (
            <AgentButton
              key={agentId}
              agent={agentsById.get(agentId) ?? initialState.agents[0]}
              selected={selectedAgent === agentId}
              onClick={() => chooseAgent(agentId)}
            />
          ))}
        </nav>

        <div className="sidebarFooter">
          <button className="settingsBtn" type="button" onClick={() => setShowSettings(true)} title="智能体设置">&#9881;</button>
        </div>
      </aside>

      <section className="channel" aria-label="Chat channel">
        <header className="channelHeader">
          <div>
            <p className="eyebrow">workspace</p>
            <h1>
              <svg className="workspaceIcon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.672a.5.5 0 0 1 .39.188l1.633 2.041a.5.5 0 0 0 .39.188H12.5A1.5 1.5 0 0 1 14 6.916V11.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V4.5Z" />
              </svg>
              {state.workspace.name || "Orbit"}
            </h1>
            {state.workspace.path ? <p className="workspacePath">{state.workspace.path}</p> : null}
          </div>
        </header>

        <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-label="Message list" onScroll={handleMessagesScroll}>
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
              <p className="emptyTitle">Ready to launch</p>
              <ol className="emptySteps">
                <li><strong>1</strong> Select an agent from the sidebar</li>
                <li><strong>2</strong> Type your task with <code>@agent:</code></li>
                <li><strong>3</strong> Watch agents collaborate</li>
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
              placeholder={`@${selectedAgent}: Hello!`}
              aria-label="Message to agent"
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
          <button type="submit" disabled={!content.trim() || isSending}>
            {isSending ? <span className="sendSpinner" aria-hidden="true" /> : "Send"}
          </button>
        </form>
      </section>
      {showSettings ? (
        <AgentSettingsPanel
          onClose={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); window.location.reload(); }}
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

function AgentSettingsPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
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
          <h2>智能体设置</h2>
          <button type="button" onClick={onClose}>&times;</button>
        </div>
        {loading ? <p className="settingsLoading">加载中...</p> : (
          <div className="settingsBody">
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
            <button type="button" className="addBtn" onClick={addConfig}>+ 添加智能体</button>
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
