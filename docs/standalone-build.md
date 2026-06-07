# Standalone Build

Orbit can be built as a standalone executable using Bun's compile feature. This produces a self-contained binary with:

- Embedded Bun runtime (no Node.js required)
- Bytecode-compiled JavaScript (source code protection)
- Minified code (no source maps)

## Prerequisites

- Bun 1.0+ installed on the build machine

Install Bun: https://bun.sh/docs/installation

## Build

### Build for current platform

```bash
# First build the UI assets
npm run build

# Then build the standalone executable
npm run build:standalone
```

Output: `dist/bin/orbit` (or `orbit.exe` on Windows)

### Build for all platforms

```bash
npm run build:standalone:all
```

Outputs:
- `dist/bin/orbit.exe` (Windows x64)
- `dist/bin/orbit` (Linux x64)
- `dist/bin/orbit` (macOS x64)
- `dist/bin/orbit` (macOS ARM64)

### Build for specific platform

```bash
node scripts/build-standalone.mjs --platform=windows
node scripts/build-standalone.mjs --platform=linux
node scripts/build-standalone.mjs --platform=macos
node scripts/build-standalone.mjs --platform=macosArm
```

## Distribution

The standalone executable needs UI assets to be distributed alongside it.

**Option 1: Environment variable**

```bash
# Set ORBIT_UI_DIR to the UI assets directory
ORBIT_UI_DIR=/path/to/dist/ui ./orbit
```

**Option 2: Relative path**

Place `dist/ui/` directory in the same location as the binary:

```
orbit.exe
dist/ui/
  index.html
  assets/
    ...
```

## Source Protection

The standalone build uses Bun's bytecode compilation which converts JavaScript to a binary format that is difficult to reverse engineer:

- `--bytecode`: Compiles JS to bytecode (not readable text)
- `--minify`: Removes comments, shortens variable names
- `--sourcemap=none`: No source maps included

This provides significantly better source protection than the standard npm package which contains minified but still readable JavaScript.

## Limitations

- Requires Bun on the build machine (users don't need it)
- Binary size is larger (~50-100MB) due to embedded runtime
- Cross-platform builds require running on each target platform or using cross-compilation tools