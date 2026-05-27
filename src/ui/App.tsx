import { FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown-renderer.ts";
import type { AgentActivityEvent, AgentId, AgentState, AppState, ChatMessage, RuntimeEvent } from "../shared/types.ts";

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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showNewMessageHint, setShowNewMessageHint] = useState(false);
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

    return agentIds.filter((agentId) => agentId.toLowerCase().startsWith(mentionDraft.query.toLowerCase()));
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
    setSelectedAgent(agentId);
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
      </aside>

      <section className="channel" aria-label="Chat channel">
        <header className="channelHeader">
          <div>
            <p className="eyebrow">workspace</p>
            <h1>{state.workspace.name || "Orbit"}</h1>
            {state.workspace.path ? <p className="workspacePath">{state.workspace.path}</p> : null}
          </div>
          <div className="quickActions" aria-label="Quick agent selection">
            {agentIds.map((agentId) => (
              <button
                key={agentId}
                className={selectedAgent === agentId ? "active" : ""}
                type="button"
                onClick={() => chooseAgent(agentId)}
              >
                @{agentId}
              </button>
            ))}
          </div>
        </header>

        <div ref={messagesRef} className="messages" role="log" aria-live="polite" aria-label="Message list" onScroll={handleMessagesScroll}>
          {state.messages.length === 0 ? (
            <div className="emptyState">Choose an agent, then type a task.</div>
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
              ↓ 滚动到底部
            </button>
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <div className="composerInputWrap">
            <input
              ref={inputRef}
              value={content}
              onBlur={() => window.setTimeout(() => setInputFocused(false), 120)}
              onChange={(event) => {
                setContent(event.target.value);
                setCursorIndex(event.target.selectionStart ?? event.target.value.length);
              }}
              onClick={updateCursorFromInput}
              onFocus={(event) => {
                setInputFocused(true);
                setCursorIndex(event.target.selectionStart ?? event.target.value.length);
              }}
              onKeyDown={handleComposerKeyDown}
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
            {isSending ? "Sending" : "Send"}
          </button>
        </form>
      </section>
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
        const agent = props.agentsById.get(agentId);
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
            <span>@{agentId}</span>
            <small>{agent?.status ?? "idle"}</small>
          </button>
        );
      })}
    </div>
  );
}

function AgentButton(props: { agent: AgentState; selected: boolean; onClick: () => void }) {
  return (
    <button className={`agentButton ${props.selected ? "selected" : ""}`} onClick={props.onClick} type="button">
      <span className={`statusDot ${props.agent.status}`} aria-hidden="true" />
      <span className="agentText">
        <strong>
          {props.agent.label}
          <RuntimeBadge runtime={props.agent.runtime} />
        </strong>
        <small>{props.agent.id}</small>
      </span>
      <span className="agentStatus">{props.agent.status}</span>
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
