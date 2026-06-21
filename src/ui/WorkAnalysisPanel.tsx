import { useEffect, useMemo, useState } from "react";

import type { WorkAnalysis, WorkTask, WorkTaskRunStatus, WorkTaskStatus } from "../shared/types.ts";

type TaskFilter = "all" | WorkTaskStatus;

export function WorkAnalysisPanel(props: {
  workspaceId: string;
  workspaceName: string;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [days, setDays] = useState(30);
  const [analysis, setAnalysis] = useState<WorkAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    if (!props.workspaceId) {
      setAnalysis(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/work-analysis?days=${days}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("协作洞察暂时无法加载");
        return response.json() as Promise<WorkAnalysis>;
      })
      .then(setAnalysis)
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "协作洞察暂时无法加载");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, props.workspaceId, refreshVersion]);

  const visibleTasks = useMemo(
    () => analysis?.tasks.filter((task) => filter === "all" || task.status === filter) ?? [],
    [analysis, filter],
  );

  return (
    <section className="analysisPage" aria-label="数字员工协作洞察">
      <header className="analysisHeader">
        <div>
          <p className="eyebrow">{props.workspaceName || "当前工作区"}</p>
          <h1>协作洞察</h1>
          <p>回顾数字员工完成的任务、协作规模与实际耗时。</p>
        </div>
        <div className="analysisHeaderActions">
          <label className="analysisRange">
            <span>统计范围</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </label>
          <button
            className="analysisRefreshBtn"
            type="button"
            onClick={() => setRefreshVersion((version) => version + 1)}
            disabled={loading}
          >
            {loading && analysis ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      <div className="analysisScroll">
        {loading && !analysis ? <AnalysisLoading /> : null}
        {!loading && error && !analysis ? <AnalysisError message={error} /> : null}
        {analysis ? (
          <>
            <section className="analysisSummary" aria-label="协作洞察总览">
              <SummaryCard label="已完成任务" value={String(analysis.summary.completedTasks)} detail={analysis.summary.runningTasks ? `${analysis.summary.runningTasks} 项进行中` : `${analysis.summary.totalTasks} 项已结束任务`} tone="accent" />
              <SummaryCard label="参与数字员工" value={String(analysis.summary.participatingAgents)} detail="统计范围内去重" />
              <SummaryCard label="多员工协作率" value={formatPercent(analysis.summary.multiAgentRate)} detail="至少 2 位数字员工参与" />
              <SummaryCard label="任务耗时中位数" value={formatDuration(analysis.summary.medianDurationMs)} detail="仅统计已完成任务" />
            </section>

            <section className="analysisPanel trendPanel">
              <div className="analysisPanelHeading">
                <div>
                  <p className="analysisKicker">完成趋势</p>
                  <h2>每天完成的任务</h2>
                </div>
                <span>{analysis.summary.completedTasks} 项完成</span>
              </div>
              <TrendChart analysis={analysis} />
            </section>

            <section className="analysisPanel taskPanel">
              <div className="analysisPanelHeading taskPanelHeading">
                <div>
                  <p className="analysisKicker">任务记录</p>
                  <h2>最近的任务</h2>
                </div>
                <div className="taskFilters" aria-label="按状态筛选任务">
                  {(["all", "running", "completed", "failed", "cancelled"] as TaskFilter[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={filter === status ? "active" : ""}
                      onClick={() => setFilter(status)}
                    >
                      {filterLabel(status)}
                    </button>
                  ))}
                </div>
              </div>

              {visibleTasks.length === 0 ? (
                <div className="analysisEmpty">
                  <strong>{analysis.tasks.length === 0 ? "还没有可分析的任务" : "没有符合筛选条件的任务"}</strong>
                  <span>{analysis.tasks.length === 0 ? "数字员工开始执行任务后，记录会出现在这里。" : "换一个状态看看其他任务。"}</span>
                </div>
              ) : (
                <div className="taskList">
                  {visibleTasks.map((task) => (
                    <TaskRow
                      key={`${task.conversationId}:${task.id}`}
                      task={task}
                      expanded={expandedTaskId === `${task.conversationId}:${task.id}`}
                      onToggle={() => {
                        const id = `${task.conversationId}:${task.id}`;
                        setExpandedTaskId((current) => current === id ? null : id);
                      }}
                      onOpenConversation={() => props.onOpenConversation(task.conversationId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </section>
  );
}

function SummaryCard(props: { label: string; value: string; detail: string; tone?: "accent" }) {
  return (
    <article className={`summaryCard ${props.tone ?? ""}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </article>
  );
}

function TrendChart({ analysis }: { analysis: WorkAnalysis }) {
  const points = analysis.trend;
  const max = Math.max(1, ...points.map((point) => point.completedTasks));
  return (
    <div className="trendChart" role="img" aria-label={`最近 ${analysis.days} 天每天完成任务数量`}>
      {points.map((point, index) => (
        <div className="trendColumn" key={point.date} title={`${formatDate(point.date)}：${point.completedTasks} 项`}>
          <span className="trendValue">{point.completedTasks || ""}</span>
          <span className="trendTrack">
            <span className="trendBar" style={{ height: `${Math.max(point.completedTasks ? 12 : 2, point.completedTasks / max * 100)}%` }} />
          </span>
          {(points.length <= 14 || index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0) ? (
            <span className="trendDate">{formatShortDate(point.date)}</span>
          ) : <span className="trendDate" aria-hidden="true" />}
        </div>
      ))}
    </div>
  );
}

function TaskRow(props: { task: WorkTask; expanded: boolean; onToggle: () => void; onOpenConversation: () => void }) {
  const { task } = props;
  return (
    <article className={`taskRow ${props.expanded ? "expanded" : ""}`}>
      <button className="taskRowMain" type="button" onClick={props.onToggle} aria-expanded={props.expanded}>
        <span className={`taskStatus ${task.status}`} aria-label={statusLabel(task.status)} />
        <span className="taskIdentity">
          <strong>{task.title}</strong>
          <small>{task.conversationName} · {task.completedAt ? formatDateTime(task.completedAt) : `开始于 ${formatDateTime(task.createdAt)}`}</small>
        </span>
        <span className="taskAgents" title={task.agents.map((agent) => agent.label).join("、")}>
          <span className="agentStack" aria-hidden="true">
            {task.agents.slice(0, 4).map((agent) => <span key={agent.agentId}>{agent.label.slice(0, 1)}</span>)}
          </span>
          <small>{task.agents.length} 位</small>
        </span>
        <span className="taskDuration">{formatDuration(task.durationMs)}</span>
        <span className={`taskStatusLabel ${task.status}`}>{statusLabel(task.status)}</span>
        <span className="taskChevron" aria-hidden="true">⌄</span>
      </button>
      {props.expanded ? (
        <div className="taskDetail">
          <div className="taskTimeline">
            <div className="taskTimelineHeading">
              <strong>执行时间轴</strong>
            </div>
            {task.runs.map((run) => {
              const left = task.durationMs ? Math.min(100, run.offsetMs / task.durationMs * 100) : 0;
              const width = run.status === "queued"
                ? 2
                : Math.max(2, Math.min(100 - left, task.durationMs ? run.durationMs / task.durationMs * 100 : 2));
              return (
                <div className="taskTimelineRun" key={run.id}>
                  <span className="taskTimelineLabel" title={run.label}>{run.label}</span>
                  <span className="taskTimelineTrack">
                    <span
                      className={`taskTimelineBar ${run.status}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${run.label} · ${runStatusLabel(run.status)} · ${formatDuration(run.durationMs)}`}
                    />
                  </span>
                  <small>{runStatusLabel(run.status)} · {formatDuration(run.durationMs)}</small>
                </div>
              );
            })}
          </div>
          <button className="openConversationBtn" type="button" onClick={props.onOpenConversation}>打开相关会话</button>
        </div>
      ) : null}
    </article>
  );
}

function AnalysisLoading() {
  return <div className="analysisState"><span className="analysisSpinner" /><strong>正在整理任务数据</strong></div>;
}

function AnalysisError({ message }: { message: string }) {
  return <div className="analysisState error"><strong>{message}</strong><span>稍后重新打开协作洞察即可重试。</span></div>;
}

function statusLabel(status: WorkTaskStatus): string {
  return status === "running" ? "进行中" : status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消";
}

function runStatusLabel(status: WorkTaskRunStatus): string {
  return status === "queued" ? "等待中" : statusLabel(status);
}

function filterLabel(filter: TaskFilter): string {
  return filter === "all" ? "全部" : statusLabel(filter);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) return "—";
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds ? `${seconds}秒` : ""}`;
  return `${seconds}秒`;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(dateKeyToLocalDate(date));
}

function formatShortDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(dateKeyToLocalDate(date));
}

/**
 * Parse a "YYYY-MM-DD" local-day key (work-analysis emits it as a local
 * calendar date) into a Date in LOCAL time. Date-only ISO strings and the
 * `T00:00:00Z` form parse as UTC, which shifts the displayed day by one in
 * UTC- timezones — building from numeric components keeps the calendar day
 * stable in every timezone.
 */
function dateKeyToLocalDate(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateTime(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}
