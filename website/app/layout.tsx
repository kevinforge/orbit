import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Orbit — 让 Agent 真正成为你的团队',
  description: 'Orbit 是本地优先的多 Agent 工作台。把 Claude Code、Codex 与 CodeBuddy 编排进同一个可回看的工作流。',
  openGraph: { title: 'Orbit — 让 Agent 真正成为你的团队', description: '一个工作区。多个数字员工。每一步都清楚可见。', type: 'website' }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
