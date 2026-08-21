# Orbit 中文快速上手

这份指南面向第一次使用 Orbit 的用户。按顺序完成即可，不需要先理解内部实现。

## Orbit 能做什么

Orbit 是一个本地优先的数字员工工作台。你把本地项目目录交给 Orbit，然后在聊天框里用数字员工的自定义名称进行指派。

软件开发团队模板默认包括：

- `@范同经:` 用于梳理需求和拆分范围。
- `@甄架构:` 用于阅读代码、设计方案和评估风险。
- `@蔡一平:` 用于修改代码、运行命令和验证改动。
- `@田小坑:` 用于验证功能、运行测试和报告问题。

每个会话都有交互模式，在输入框旁的模式菜单中切换：普通对话（与一位数字员工持续交流，新会话默认）、简单协作（按需协作）和复杂协作（启用内置监工）。

完整术语和路由规则见 [Terminology And Routing](TERMINOLOGY_AND_ROUTING.md)。

第一次使用建议选择“软件开发团队”数字员工团队模板。Orbit 会默认启用适合协作开发的数字员工配置。

## 第 0 步：准备环境

先检查你的电脑是否已经安装 Node.js 和至少一个数字员工运行时。打开 PowerShell 或终端：

```powershell
node --version
npm --version
```

如果 `node --version` 显示 `v22.x.x` 或更高版本，并且 `npm --version` 能显示版本号，说明 Node.js 和 npm 已可用。

如果没有 Node.js，或版本低于 22：

1. 打开 https://nodejs.org/
2. 下载 LTS 版本，要求 Node.js 22 或更高。
3. 使用默认选项安装。
4. 关闭当前终端，重新打开一个新的终端。
5. 再次运行 `node --version` 和 `npm --version`。

Orbit 提供网页工作台，真正执行任务的是背后的 CLI 运行时。你至少需要一个运行时可用，不需要一开始就安装全部三个。

检查你准备使用的厂商运行时：

```powershell
claude --version
codex --version
codebuddy --version
```

如果至少一个命令能显示版本，就可以继续。缺少的运行时以后也可以按 Orbit UI 里的提示安装。

如果三个命令都不可用，请至少安装一个：

| 运行时 | 常见用途 | 安装方式 |
| --- | --- | --- |
| Claude Code | 开发、监督 | Orbit 已内置 ACP 适配器，只需安装并登录 Claude Code |
| OpenAI Codex | 产品、架构、通用任务 | Orbit 已内置 ACP 适配器，只需安装并登录 Codex |
| CodeBuddy | 测试或自定义员工 | `npm install -g @tencent-ai/codebuddy-code` |

如果 npm 安装卡住、超时或下载失败，通常是网络无法稳定访问 npm 源。可以切换到能访问 npm 的网络，或临时使用镜像源：

```powershell
npm config set registry https://registry.npmmirror.com
```

安装运行时后，再按各自 CLI 的提示完成登录。Orbit 会自动使用内置的 ACP 适配器连接 Claude Code 和 Codex，不需要额外安装 `claude-agent-acp` 或 `codex-acp`。Orbit 只能调用已经能在本机正常运行的运行时。

## 第 1 步：安装 Orbit

### 从 GitHub Release 安装

下载与你的操作系统匹配的 Orbit 发布包，然后在发布包所在目录打开终端。Windows x64 用户执行：

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
```

Linux 和 macOS 用户请使用对应平台的 `.tgz` 安装包。

### 从公开 npm 安装

公开 npm 发布准备好之后，可以安装 scoped 包：

```powershell
npm install -g @kevinforge/orbit
```

不要安装公开 npm 上的 `orbit` 包。那个包与本项目无关。如果你已经执行过 `npm install -g orbit`，并且启动时报 `ERR_PACKAGE_PATH_NOT_EXPORTED` 或 `uuid/v1`，请先卸载错误的包：

```powershell
npm uninstall -g orbit
npm install -g @kevinforge/orbit
```

### 从源码运行

```powershell
npm ci
npm run build
npm run dev
```

## 第 2 步：启动 Orbit

执行：

```powershell
orbit
```

启动成功后，打开浏览器访问：

```text
http://localhost:4317
```

## 第 3 步：创建第一个工作区

工作区就是你要让数字员工处理的本地项目目录。

1. 打开 Orbit 页面。
2. 点击左侧“工作区”旁边的 `+`。
3. 选择一个本地项目目录。
4. 如果出现模板选择，第一次使用建议选择“软件开发团队”。
5. 创建成功后，左侧会出现该工作区和一个新会话。

选择“软件开发团队”时，Orbit 会默认启用范同经、甄架构、蔡一平和田小坑四个数字员工，并把它们配置到当前可用的运行时上。选择“空白”则不会自动启用数字员工，你需要自己配置。

## 第 4 步：确认数字员工和运行环境

如果左侧“数字员工”区域提示还没有启用数字员工：

1. 点击“数字员工”旁边的 `+`。
2. 在弹窗里打开需要的数字员工开关。
3. 新手建议至少启用“蔡一平”；如果需要完整协作流程，再启用“范同经”、“甄架构”和“田小坑”。复杂协作的内置监工通过会话模式菜单启用，无需配置为数字员工。
4. 检查每个数字员工的运行时是否显示可用。
5. 点击保存。

如果 Orbit 提示某个运行时未安装，先复制页面上的安装命令，在终端里安装对应 CLI，并完成 CLI 自己的登录流程。回到 Orbit 后点击“重新检测运行环境”。

## 第 5 步：发出第一条任务

在底部输入框输入一条带 `@数字员工名称:` 的任务，然后按 Enter 发送。名称必须与左侧显示的名称完全一致。

例如，让甄架构先读项目：

```text
@甄架构: 请先阅读这个项目的结构，用新手能听懂的话说明它是做什么的，并告诉我如果要新增一个功能应该从哪里开始。
```

如果你想直接让开发动手：

```text
@蔡一平: 请帮我在 README 里补充本地启动步骤。改动要尽量小，完成后运行相关检查，并告诉我改了哪些文件。
```

如果当前会话选择“复杂协作”，也可以直接描述目标，让内置监工帮助分配：

```text
请帮我给这个项目增加一个登录页的表单校验，要求先评估方案，再实现，再测试。
```

点击侧栏底部的“协作洞察”，可以查看已完成与进行中的任务、参与数字员工、执行时间线和端到端耗时。

## 常见问题

### Orbit 要联网吗？

Orbit 的产品数据保存在本机 `~/.orbit`。但数字员工背后的 CLI 是否联网，取决于你使用的 Claude Code、Codex 或 CodeBuddy。

### 我需要安装三个运行时吗？

不需要。至少一个可用运行时即可开始。某个数字员工只有在它选择的运行时已安装并登录后才能工作。

### 本地数据在哪里？

Orbit 数据在 `~/.orbit`。备份、恢复和删除说明见 [DATA_DIRECTORY.md](DATA_DIRECTORY.md)。

### 路由标记怎么写？

使用 `@数字员工名称:`，例如 `@蔡一平:`。完整规则见 [TERMINOLOGY_AND_ROUTING.md](TERMINOLOGY_AND_ROUTING.md)。
