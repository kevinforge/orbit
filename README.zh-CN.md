# Orbit

Orbit 是一个本地优先的数字员工协作工作台，可在相互隔离的工作区与会话中协调多个 CLI 后端数字员工。

## 安装

安装管理员提供的 Orbit 发布包：

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
```

请从私有 GitHub Release 下载与操作系统匹配的 Orbit 发布包，或通过管理员提供的私有 npm 源安装。不要直接从公开 npm
执行 `npm install -g orbit`：公开 npm 上的 `orbit` 是另一个同名项目，可能会在
Node 24 下启动时报 `ERR_PACKAGE_PATH_NOT_EXPORTED` 和 `uuid/v1` 错误。

## 启动

```powershell
orbit
```

打开 `http://localhost:4317`。

第一次使用请阅读[中文快速上手](docs/QUICKSTART.zh-CN.md)，英文版见 [Quickstart](docs/QUICKSTART.md)。

## 环境要求

Orbit 协调 CLI 后端数字员工，数字员工需要以下运行时：

| 运行时 | 安装方式 |
|--------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` |

## 功能

- 五个内置数字员工模板：产品经理（pm）、架构师（architect）、开发（developer）、测试（tester）、监督者（supervisor）
- 通过 UI 创建和配置自定义数字员工及其权限
- 空白工作区和多数字员工协作模板
- 多会话后台执行，并在侧栏显示正在工作的数字员工
- 明确指派、员工交接和每位数字员工的独立任务队列
- 协作洞察：任务结果、协作规模、执行时间轴与耗时趋势
- 数字员工回复支持 Markdown，运行过程提供可读活动与失败线索
- 会话持久化，数字员工在多次运行间保留上下文
