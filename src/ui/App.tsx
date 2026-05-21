import { FormEvent, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentId, AgentState, AppState, ChatMessage, RuntimeEvent } from "../shared/types.ts";

const AGENT_IDS: AgentId[] = ["agent1", "agent2"];

const initialState: AppState = {
  agents: [
    { id: "agent1", label: "Agent 1", status: "starting", selected: true },
    { id: "agent2", label: "Agent 2", status: "starting", selected: false },
  ],
  messages: [],
  terminal: { agent1: "", agent2: "" },
};

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [content, setContent] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId>("agent1");
  const [connectionState, setConnectionState] = useState<"connecting" | "live" | "offline">("connecting");
  const [isSending, setIsSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);

  const agentsById = useMemo(() => new Map(state.agents.map((agent) => [agent.id, agent])), [state.agents]);
  const mentionDraft = useMemo(() => findMentionDraft(content, cursorIndex), [content, cursorIndex]);
  const mentionCandidates = useMemo(() => {
    if (!inputFocused || !mentionDraft) {
      return [];
    }

    return AGENT_IDS.filter((agentId) => agentId.toLowerCase().startsWith(mentionDraft.query.toLowerCase()));
  }, [inputFocused, mentionDraft]);

  useEffect(() => {
    setSelectedMentionIndex(0);
  }, [mentionDraft?.query]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || isSending) {
      return;
    }

    const routedContent = startsWithKnownMention(trimmed) ? trimmed : `@${selectedAgent} ${trimmed}`;

    setIsSending(true);
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: routedContent }),
      });

      if (!response.ok) {
        throw new Error(`Message request failed: ${response.status}`);
      }

      setContent("");
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

    const nextContent = `${content.slice(0, mentionDraft.start)}@${agentId} ${content.slice(mentionDraft.end)}`;
    const nextCursorIndex = mentionDraft.start + agentId.length + 2;
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
          {AGENT_IDS.map((agentId) => (
            <AgentButton
              key={agentId}
              agent={agentsById.get(agentId) ?? initialState.agents.find((agent) => agent.id === agentId)!}
              selected={selectedAgent === agentId}
              onClick={() => chooseAgent(agentId)}
            />
          ))}
        </nav>
      </aside>

      <section className="channel" aria-label="Chat channel">
        <header className="channelHeader">
          <div>
            <p className="eyebrow">local channel</p>
            <h1>Orbit P0</h1>
          </div>
          <div className="quickActions" aria-label="Quick agent selection">
            {AGENT_IDS.map((agentId) => (
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

        <div className="messages" role="log" aria-live="polite" aria-label="Message list">
          {state.messages.length === 0 ? (
            <div className="emptyState">Choose an agent, then type a task.</div>
          ) : (
            state.messages.map((message) => <MessageRow key={message.id} message={message} />)
          )}
          <div ref={messagesEndRef} />
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
              placeholder={`@${selectedAgent} Hello!`}
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
        <strong>{props.agent.label}</strong>
        <small>{props.agent.id}</small>
      </span>
      <span className="agentStatus">{props.agent.status}</span>
    </button>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const author = message.kind === "user" ? "You" : message.kind === "agent" ? message.agentId ?? "agent" : "system";

  return (
    <article className={`message ${message.kind}`}>
      <div className="messageMeta">
        <strong>{author}</strong>
        {message.status ? <span>{message.status}</span> : null}
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      <div className="messageBody">
        {message.kind === "agent" ? <MarkdownContent content={message.content} /> : <PlainText content={message.content} />}
      </div>
    </article>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(<Tag key={blocks.length}>{renderInline(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test((lines[index] ?? "").trim())) {
        items.push(<li key={items.length}>{renderInline((lines[index] ?? "").trim().replace(/^[-*]\s+/, ""))}</li>);
        index += 1;
      }
      blocks.push(<ul key={blocks.length}>{items}</ul>);
      continue;
    }

    if (looksLikeTableRow(trimmed)) {
      const rows: string[][] = [];
      while (index < lines.length && looksLikeTableRow((lines[index] ?? "").trim())) {
        const row = (lines[index] ?? "").trim();
        if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(row)) {
          rows.push(splitTableRow(row));
        }
        index += 1;
      }
      blocks.push(<MarkdownTable key={blocks.length} rows={rows} />);
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? "").trim();
      if (!current || /^(#{1,6})\s+/.test(current) || /^[-*]\s+/.test(current) || looksLikeTableRow(current)) {
        break;
      }
      paragraphLines.push(current);
      index += 1;
    }
    blocks.push(<p key={blocks.length}>{renderInline(paragraphLines.join(" "))}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}

function MarkdownTable({ rows }: { rows: string[][] }) {
  if (rows.length === 0) {
    return null;
  }

  const [header, ...body] = rows;
  return (
    <div className="markdownTableWrap">
      <table>
        <thead>
          <tr>{header.map((cell, index) => <th key={index}>{renderInline(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlainText({ content }: { content: string }) {
  return <div className="plainText">{content}</div>;
}

function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2;
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
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
    agents: nextState.agents?.length ? nextState.agents : initialState.agents,
    messages: nextState.messages ?? [],
    terminal: {
      agent1: "",
      agent2: "",
    },
  };
}

function startsWithKnownMention(value: string): boolean {
  return /^@agent[12]\b/.test(value);
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

function createLocalSystemMessage(content: string): ChatMessage {
  return {
    id: `local_${Date.now()}`,
    kind: "system",
    content,
    createdAt: new Date().toISOString(),
    status: "error",
  };
}
