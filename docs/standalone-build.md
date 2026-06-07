# npm 包安装

Orbit 通过 npm 包分发，内嵌 Bun 编译的独立可执行文件。

## 发布前构建

```powershell
npm run build
```

这会生成：
- `dist/bin/orbit.exe`（Windows）或 `dist/bin/orbit`（Linux/macOS）— 字节码编译的可执行文件
- `dist/ui/` — UI 静态资源

## 打包与安装

```powershell
# 打包为 tgz
npm pack

# 本地安装测试
npm install -g .\orbit-<version>.tgz
```

版本号由 `package.json` 的 `version` 字段决定。

## 发布到 npm

```powershell
npm publish
```

`prepublishOnly` 钩子会自动运行测试和构建。

## 用户安装

```powershell
npm install -g orbit
```

`postinstall` 脚本会自动检测平台，将匹配的二进制文件复制到 `bin/` 目录。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ORBIT_PORT` | 服务端口 | `4317` |
| `ORBIT_UI_DIR` | UI 资源目录 | 包内的 `dist/ui/` |

## 源码保护

Bun compile 提供三种保护机制：

| 机制 | 效果 |
|------|------|
| `--bytecode` | JS 源码编译为二进制字节码，无法直接读取 |
| `--minify` | 删除注释、缩短变量名 |
| `--sourcemap=none` | 不生成 source map，切断逆向还原路径 |

## 运行时 CLI 依赖

Orbit 本身不需要 CLI 环境，但它调度的 agent 需要：

| Runtime | 安装方式 |
|---------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | 参考官方安装文档 |