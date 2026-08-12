import * as TDesign from "tdesign-react";
import { CheckCircleFilledIcon, ErrorCircleFilledIcon, TimeIcon } from "tdesign-icons-react";
import type { AgentActivityEvent, AgentState, ChatMessage } from "../shared/types.ts";

const { Avatar, Collapse, Drawer, Progress, Tag } = TDesign;

type TaskDetailDrawerProps = {
  message: ChatMessage | null;
  parentMessage?: ChatMessage;
  agent?: AgentState;
  agents: AgentState[];
  visible: boolean;
  onClose: () => void;
};

export function TaskDetailDrawer(props: TaskDetailDrawerProps) {
  const { message, parentMessage, agent, agents, visible, onClose } = props;
  if (!message) return null;

  const status = taskStatus(message);
  const duration = getDuration(message);
  const description = parentMessage?.content?.trim() || message.content.trim();
  const activity = message.activity ?? [];

  return (
    <Drawer
      className="taskDetailDrawer"
      visible={visible}
      placement="right"
      size="380px"
      header="任务详情"
      footer={false}
      closeOnEscKeydown
      closeOnOverlayClick
      onClose={onClose}
    >
      <div className="taskDrawerBody">
        <section className="taskDrawerSection taskDrawerOverview">
          <div className="taskDrawerOwner">
            <Avatar size="32px" style={{ backgroundColor: roleColor(agent?.role) }}>
              {(agent?.label || message.agentId || "员工").slice(0, 1)}
            </Avatar>
            <div>
              <strong>{agent?.label || message.agentId || "数字员工"}</strong>
              <span>{message.agentId ? `@${message.agentId}` : "数字员工任务"}</span>
            </div>
            <Tag theme={status.theme} variant="light" icon={status.icon}>{status.label}</Tag>
          </div>
          <p className="taskDrawerDescription">{compactText(description, 180)}</p>
        </section>

        <section className="taskDrawerSection">
          <div className="taskDrawerSectionTitle">
            <strong>任务进度</strong>
            <span>{status.percentage}%</span>
          </div>
          <Progress
            percentage={status.percentage}
            label={false}
            strokeWidth={6}
            color={status.color}
            trackColor="#edf0f2"
            status={status.progressStatus}
          />
          <dl className="taskDrawerFacts">
            <div><dt>开始时间</dt><dd>{formatDateTime(message.startedAt ?? message.createdAt)}</dd></div>
            <div><dt>完成时间</dt><dd>{message.completedAt ? formatDateTime(message.completedAt) : "-"}</dd></div>
            <div><dt>耗时</dt><dd><TimeIcon />{duration}</dd></div>
          </dl>
        </section>

        <section className="taskDrawerSection">
          <strong className="taskDrawerHeading">参与员工</strong>
          <div className="taskDrawerAgents">
            {agents.map((item) => (
              <div className="taskDrawerAgent" key={item.id}>
                <span className={`taskDrawerAgentDot ${item.status}`} style={{ backgroundColor: roleColor(item.role) }} />
                <span className="taskDrawerAgentName"><strong>{item.label}</strong><small>@{item.id}</small></span>
                <Tag size="small" variant="outline">{runtimeLabel(item.runtime)}</Tag>
              </div>
            ))}
          </div>
        </section>

        <section className="taskDrawerSection taskDrawerActivity">
          <Collapse borderless defaultValue={[]} expandIconPlacement="right">
            <Collapse.Panel value="activity" header={`运行记录 ${activity.length} 条`}>
              {activity.length > 0 ? (
                <div className="taskDrawerTimeline">
                  {activity.map((item, index) => (
                    <div className={`taskDrawerEvent ${item.type.replace(".", "-")}`} key={`${item.timestamp}-${index}`}>
                      <span className="taskDrawerEventDot" />
                      <span>{activityText(item)}</span>
                      <time>{formatTime(item.timestamp)}</time>
                    </div>
                  ))}
                </div>
              ) : <p className="taskDrawerEmpty">当前任务没有详细运行记录。</p>}
            </Collapse.Panel>
          </Collapse>
        </section>
      </div>
    </Drawer>
  );
}

function taskStatus(message: ChatMessage) {
  if (message.status === "error" || message.runStatus === "failed") {
    return { label: "失败", percentage: 100, theme: "danger" as const, color: "#d54941", progressStatus: "error" as const, icon: <ErrorCircleFilledIcon /> };
  }
  if (message.status === "cancelled" || message.runStatus === "cancelled") {
    return { label: "已取消", percentage: 100, theme: "warning" as const, color: "#ed7b2f", progressStatus: "warning" as const, icon: <ErrorCircleFilledIcon /> };
  }
  if (message.status === "running" || message.runStatus === "running") {
    return { label: "运行中", percentage: 68, theme: "primary" as const, color: "#0052d9", progressStatus: "active" as const, icon: <TimeIcon /> };
  }
  if (message.runStatus === "queued") {
    return { label: "等待中", percentage: 12, theme: "default" as const, color: "#7b8794", progressStatus: "active" as const, icon: <TimeIcon /> };
  }
  return { label: "已完成", percentage: 100, theme: "success" as const, color: "#00a870", progressStatus: "success" as const, icon: <CheckCircleFilledIcon /> };
}

function getDuration(message: ChatMessage): string {
  const start = new Date(message.startedAt ?? message.createdAt).getTime();
  const end = message.completedAt ? new Date(message.completedAt).getTime() : Date.now();
  const milliseconds = Math.max(0, end - start);
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function activityText(item: AgentActivityEvent): string {
  if (item.type === "status") return item.text;
  if (item.type === "tool.started") return `开始 ${item.name}`;
  if (item.type === "tool.completed") return item.summary || `完成 ${item.name}`;
  if (item.type === "tool.failed") return item.summary || `${item.name} 执行失败`;
  return item.message;
}

function runtimeLabel(runtime: AgentState["runtime"]): string {
  if (runtime === "claude-code") return "CLAUDE";
  if (runtime === "codebuddy") return "CODEBUDDY";
  return "CODEX";
}

function roleColor(role?: AgentState["role"]): string {
  if (role === "architect") return "#0052d9";
  if (role === "developer") return "#00a870";
  if (role === "tester") return "#ed7b2f";
  if (role === "coordinator") return "#8e56dd";
  if (role === "pm") return "#d54941";
  return "#6b7785";
}
