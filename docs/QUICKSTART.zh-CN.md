# Orbit 小白快速上手

这份指南面向第一次使用 Orbit 的中文用户。按步骤做即可，不需要先理解内部原理。

## 你会用 Orbit 做什么

Orbit 是一个本地优先的数字员工工作台。左侧默认会显示这些数字员工：产品经理（pm）、架构师（architect）、开发（developer）、测试（tester）、监督者（supervisor）。你把本地项目目录交给 Orbit，然后在聊天框里用固定的 `@id:` 把任务分配给不同数字员工：

- `@pm:` 指派给「产品经理（pm）」，用于澄清需求、拆范围。
- `@architect:` 指派给「架构师（architect）」，用于先看代码、拆方案、评估风险。
- `@developer:` 指派给「开发（developer）」，用于修改代码、运行命令、提交变更。
- `@tester:` 指派给「测试（tester）」，用于验证功能、运行测试、报告问题。
- `@supervisor:` 指派给「监督者（supervisor）」，用于帮助推动任务闭环。
- `@all:` 同时把任务发给当前启用的多个数字员工。

第一次使用建议选择「多数字员工协作」模板，Orbit 会默认启用适合协作开发的数字员工配置。

## 第 0 步：准备环境

先检查你的电脑是否已经有 Node.js 和数字员工运行时。已经安装并且版本符合要求的，可以直接跳过对应安装步骤。

打开 PowerShell，执行：

```powershell
node --version
npm --version
```

如果 `node --version` 能显示 `v20.x.x` 或更高版本，并且 `npm --version` 也能显示版本号，说明 Node.js 和 npm 已经可用，不需要重复安装。

如果没有 Node.js，或者 Node.js 版本低于 20，请这样安装：

1. 打开 Node.js 官网：https://nodejs.org/
2. 下载 LTS 版本，版本号需要是 20 或更高。
3. 双击安装包，一路按默认选项安装即可。
4. 安装完成后，关闭当前 PowerShell，再重新打开一个新的 PowerShell。
5. 重新执行 `node --version` 和 `npm --version` 确认安装成功。

Orbit 负责提供网页工作台，真正执行任务的是背后的命令行工具。你至少需要一个运行时可用即可开始使用，不需要一开始就把三个都装上。先检查：

```powershell
claude --version
codex --version
codebuddy --version
```

如果其中至少一个命令能正常显示版本号，说明已经有可用运行时，可以先继续下一步。缺少的运行时以后也可以在 Orbit 页面里按提示安装。

如果三个命令都不可用，请至少选择一个安装：

| 运行时 | 常见用途 | 安装方式 |
| --- | --- | --- |
| Claude Code | 开发、监督者 | `npm install -g @anthropic-ai/claude-code` |
| OpenAI Codex | 产品、架构、通用任务 | `npm install -g @openai/codex` |
| CodeBuddy | 测试或自定义员工 | `npm install -g @tencent-ai/codebuddy-code` |

如果 npm 安装一直卡住、超时或下载失败，通常是网络无法稳定访问 npm 源。可以先开启可访问 npm 的网络环境，或者临时使用国内镜像源：

```powershell
npm config set registry https://registry.npmmirror.com
```

如果你在公司网络或代理网络下，需要按你的网络环境配置代理后再执行 `npm install -g ...`。

安装后，请重新执行对应的版本检查命令，例如 `codebuddy --version`。然后在终端里单独运行对应 CLI，并按它自己的提示完成登录或授权。Orbit 只能调用已经能在你本机正常运行的 CLI。

## 第 1 步：安装 Orbit

先从管理员处获取 Orbit 发布包，然后在发布包所在目录打开 PowerShell，执行：

```powershell
npm install -g .\orbit-<version>.tgz
```

不要直接从公开 npm 安装 `orbit`。公开 npm 上的 `orbit` 是另一个同名项目。
如果你已经执行过 `npm install -g orbit`，并且运行 `orbit --machine-id` 时看到
`ERR_PACKAGE_PATH_NOT_EXPORTED` 和 `uuid/v1`，请先卸载错误的包，再安装 Orbit
发布包：

```powershell
npm uninstall -g orbit
npm install -g .\orbit-<version>.tgz
```

安装完成后，先获取机器码：

```powershell
orbit --machine-id
```

Orbit 会输出一串机器码，并自动创建授权目录。你会看到类似这样的提示：

```text
Orbit 机器码
===========

  示例机器码-请使用你电脑实际输出的那一串

下一步：
1. 将上面的机器码发送给管理员。上面这串只是文档示例，实际请发送你电脑上显示的机器码。
2. 管理员会发给你一个 license.json 文件。
3. 请把 license.json 放到这个目录：C:\Users\你的用户名\.orbit
   最终文件路径应该是：C:\Users\你的用户名\.orbit\license.json
4. 放好后重新执行：orbit
```

把机器码发给管理员，拿到 `license.json` 后，请把它放到：

```text
C:\Users\你的用户名\.orbit\license.json
```

注意：文件名必须是 `license.json`，不要改成 `license (1).json`、`license.txt` 或其他名字。

如果你还没有放好授权文件，直接执行 `orbit` 会看到中文提示，按提示完成授权即可。

## 第 2 步：启动 Orbit

授权文件放好后，执行：

```powershell
orbit
```

如果授权通过，你会看到类似提示：

```text
[orbit] 授权校验通过，正在启动 Orbit...
[orbit] Orbit 已启动。请在浏览器中打开：http://localhost:4317
```

然后打开浏览器，访问：

```text
http://localhost:4317
```

## 第 3 步：创建第一个工作区

工作区就是你要让数字员工处理的本地项目目录。

1. 打开 Orbit 页面后，点击左侧「工作区」旁边的 `+`。
2. 选择一个本地项目目录，例如你的前端、后端或脚本项目。
3. 如果出现模板选择，第一次使用建议选择「多数字员工协作」。
4. 创建成功后，左侧会出现该工作区和一个新会话。

选择「多数字员工协作」时，Orbit 会默认启用「架构师（architect）」「开发（developer）」「测试（tester）」「监督者（supervisor）」，并把它们配置到当前可用的运行时上。选择「空白工作区」则不会自动启用数字员工，你需要自己配置。

## 第 4 步：确认数字员工和运行环境

如果左侧「数字员工」区域提示还没有启用数字员工：

1. 点击「数字员工」旁边的 `+`。
2. 在弹窗里打开需要的数字员工开关。
3. 新手建议至少启用「开发（developer）」；如果想要协作流程，再启用「架构师（architect）」「测试（tester）」和「监督者（supervisor）」。
4. 检查每个数字员工的「运行时」是否显示可用。
5. 点击「保存」。

如果 Orbit 提示某个运行时未安装，先按页面上的安装入口安装对应 CLI。安装或登录完成后，回到 Orbit 点击「重新检测运行环境」。

## 第 5 步：发出第一条任务

在底部输入框里输入一条带 `@数字员工id:` 的任务，然后按 Enter 发送。左侧显示的是「中文（id）」名称，输入时仍使用英文 id，例如 `@developer:`。

例如，让架构师先看项目：

```text
@architect: 请先阅读这个项目的结构，用小白能懂的话说明它是做什么的，并告诉我如果要新增一个功能应该从哪里开始。
```

如果你想直接让开发人员动手：

```text
@developer: 请帮我在 README 里补充本地启动步骤。改动要尽量小，完成后运行相关检查，并告诉我改了哪些文件。
```

如果你启用了监督者，也可以直接描述目标，让监督者帮助分配：

```text
请帮我给这个项目增加一个登录页的表单校验，要求先评估方案，再实现，再测试。
```

## 常见问题

### 没有 `.orbit` 目录怎么办？

执行一次：

```powershell
orbit --machine-id
```

Orbit 会自动创建 `C:\Users\你的用户名\.orbit` 目录，并告诉你 `license.json` 应该放到哪里。

### 执行 `orbit` 提示未找到 `license.json`

说明还没有完成授权。请执行：

```powershell
orbit --machine-id
```

把机器码发给管理员，拿到 `license.json` 后放到：

```text
C:\Users\你的用户名\.orbit\license.json
```

然后重新执行：

```powershell
orbit
```

### 页面提示运行时未安装

说明 Orbit 没检测到对应 CLI。请先在终端里确认命令能单独运行：

```powershell
claude --version
codex --version
codebuddy --version
```

只需要检查你实际使用的运行时即可。安装或登录完成后，回到 Orbit 点击「重新检测运行环境」。

### 输入框不能发送

通常是因为还没有创建工作区，或者当前工作区没有启用任何数字员工。先创建工作区，再到「数字员工」面板启用至少一个员工。

### Orbit 会把数据放在哪里？

Orbit 是本地优先的产品，会把工作区、会话、消息、运行记录、授权文件等数据保存在你电脑的 `~/.orbit` 目录下。Windows 上通常是：

```text
C:\Users\你的用户名\.orbit
```

## 推荐的新手工作流

第一次使用时，可以按下面的节奏来：

1. 先问「架构师（architect）」`@architect:`：“这个需求应该怎么做？风险是什么？”
2. 方案满意后，让「开发（developer）」`@developer:`：“按刚才方案实现，改动要小，完成后运行测试。”
3. 开发完成后，让「架构师（architect）」`@architect:`：“请 review 刚才的改动，指出问题。”
4. 没有明显问题后，让「测试（tester）」`@tester:`：“请运行验证，并说明是否可以交付。”
5. 最后要求总结：“请用三句话告诉我改了什么、怎么验证、还有什么风险。”
