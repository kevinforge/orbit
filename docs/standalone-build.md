# 独立可执行文件打包

Orbit 可以使用 Bun 的 compile 功能打包为独立可执行文件。生成的二进制文件：

- 内嵌 Bun 运行时，无需安装 Node.js 或 Bun
- JavaScript 编译为字节码，保护源码
- 代码压缩，无 source map

## 前置条件

构建机器上需要安装 Bun 1.0+。

安装 Bun：https://bun.sh/docs/installation

```powershell
npm install -g bun
```

## 编译打包

### 为当前平台编译

```powershell
# 一键构建（类型检查 + UI + 独立可执行文件）
npm run build
```

输出：
- `dist/bin/orbit.exe`（Windows）或 `dist/bin/orbit`（Linux/macOS）
- `dist/ui/` UI 资源文件

### 为所有平台编译

```powershell
npm run build:all
```

输出：
- `dist/bin/orbit.exe` - Windows x64
- `dist/bin/orbit` - Linux x64
- `dist/bin/orbit` - macOS x64
- `dist/bin/orbit` - macOS ARM64

### 为指定平台编译

```powershell
node scripts/build-standalone.mjs --platform=windows
node scripts/build-standalone.mjs --platform=linux
node scripts/build-standalone.mjs --platform=macos
node scripts/build-standalone.mjs --platform=macosArm
```

## 本地安装（测试用）

### 创建本地安装目录

```powershell
# 创建 orbit 安装目录
mkdir D:\orbit
```

### 复制文件

```powershell
# 复制可执行文件
copy dist\bin\orbit.exe D:\orbit\

# 复制 UI 资源
xcopy /E /I dist\ui D:\orbit\dist\ui
```

### 添加到 PATH

```powershell
# 方式1：临时添加到当前终端
$env:Path = "D:\orbit;" + $env:Path

# 方式2：永久添加到系统 PATH
[Environment]::SetEnvironmentVariable("Path", "D:\orbit;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
```

### 运行

```powershell
# 在任意项目目录下运行
orbit
```

打开浏览器访问 `http://localhost:4317`。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ORBIT_PORT` | 服务端口 | `4317` |
| `ORBIT_UI_DIR` | UI 资源目录 | 二进制同级的 `dist/ui/` |

## 源码保护原理

Bun compile 提供了三种保护机制：

| 机制 | 效果 |
|------|------|
| `--bytecode` | JS 源码编译为二进制字节码，无法直接读取 |
| `--minify` | 删除注释、缩短变量名 |
| `--sourcemap=none` | 不生成 source map，切断逆向还原路径 |

对比原来的 esbuild 打包（压缩后仍是可读的 JS 文本），字节码保护力度显著提升。

## 运行时 CLI 依赖

Orbit 本身不需要 CLI 环境，但它调度的 agent 需要：

| Runtime | 安装方式 |
|---------|----------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex | `npm install -g @openai/codex` |
| CodeBuddy | 参考官方安装文档 |
