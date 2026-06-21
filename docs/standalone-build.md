# 构建与私有发布

Orbit 通过私有 GitHub Release 分发按平台构建的 npm 安装包。安装包内包含 Bun 编译的独立可执行文件和 UI 静态资源。

## 发布前构建

```powershell
npm run build
```

这会生成：
- `dist/bin/orbit.exe`（Windows）或 `dist/bin/orbit`（Linux/macOS）— 字节码编译的可执行文件
- `dist/ui/` — UI 静态资源

## 本地 npm 打包验证

```powershell
# 打包为 tgz
npm pack

# 本地安装测试
npm install -g .\orbit-<version>.tgz
```

版本号由 `package.json` 的 `version` 字段决定。

## GitHub Release 自动发布

仓库通过 `.github/workflows/release.yml` 响应语义化版本 tag，例如 `v0.9.5`：

1. 校验 tag 与 `package.json` 版本一致，且 tag 指向 `main` 已包含的提交。
2. 运行完整测试。
3. 在对应操作系统的原生 GitHub runner 上构建 Windows x64、Linux x64、macOS x64 和 macOS ARM64 可执行文件，并实际启动进行冒烟测试。
4. 为每个平台生成可通过 npm 安装的 `.tgz` 附件，校验包内不包含源码、测试、source map 或其他构建残留，并生成 SHA-256 校验文件。
5. 创建 GitHub Release 并上传所有附件；失败的测试或构建不会创建 Release。

发布步骤：

```powershell
git checkout main
git pull --ff-only origin main
git tag -a v0.9.5 -m "Orbit v0.9.5"
git push origin v0.9.5
```

tag 必须在版本修改和发布工作流合并到 `main` 后再推送。私有仓库的 Release 与附件仍受仓库读取权限保护；只有获授权并登录 GitHub 的用户可以访问。发布给用户的二进制仍应视为可被复制或分析的分发物。

首次使用或修改构建流程后，可以先在 GitHub Actions 页面手动运行 **Release** 工作流。手动运行只验证和生成临时 Actions artifacts，不会创建 Release；确认四个平台均构建成功后再推送正式 tag。

## 使用 Release 附件

下载与操作系统匹配的 `.tgz` 附件，例如 Windows x64 使用 `orbit-<version>-windows-x64.tgz`，然后直接安装：

```powershell
npm install -g .\orbit-<version>-windows-x64.tgz
orbit
```

Linux / macOS 使用对应平台的附件：

```bash
npm install -g ./orbit-<version>-<platform>.tgz
orbit
```

不要从公开 npm 源安装 `orbit`：公开 npm 上的同名包与本项目无关。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ORBIT_PORT` | 服务端口 | `4317` |
| `ORBIT_UI_DIR` | UI 资源目录 | 包内的 `dist/ui/` |

## 运行时 CLI 依赖

Orbit 本身不需要 CLI 环境，但它调度的 agent 需要：

| Runtime | 安装方式 |
|---------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | 参考官方安装文档 |
