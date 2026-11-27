# Papifa Desktop (Electron)

Desktop wrapper for **Papifa** targeting Windows x64 (`portable .exe` or `.zip`), Linux x64 (`AppImage` + `.tar.gz`), and macOS (`.zip`).

For plain step-by-step build instructions aimed at friends on Windows, Linux, or macOS, see [`../BUILDING.md`](../BUILDING.md).

## What it loads

- The build script never copies `game/` by hand. It invokes `../scripts/build-web.mjs --stage <tmp>` at a committed git ref (`--ref` / `PAPIFA_REF`, default `HEAD`), or `--worktree` for uncommitted local edits (`<commit>-dirty`). Every desktop package contains one exact static web release (including vendored `three.js` verified by SHA-256, relative asset URLs, `<base href="r/<commit>/">`, and the release Content-Security-Policy).
- `main.js` registers a privileged custom scheme **`papifa`** (`standard: true`, `secure: true`, `supportFetchAPI: true`, `corsEnabled: true`, `stream: true`) and serves the bundled `resources/web/` tree strictly from **`papifa://app`**. It never loads `file://`.
- Security defaults: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no preload script, no remote module, `<webview>` blocked, and all navigations / `window.open` targets outside `papifa://app` denied (HTTP/HTTPS links are handed to the OS browser).
- Window defaults: `1280×800`, title `"Papifa"`, Papifa shield icon (multi-size `.ico` generated in pure Node from the staged `papifa-512.png`), no menu bar, **F11** fullscreen toggle.
- **Online matches:** uses invite & reply codes (`P1I-…` / `P1R-…`) for direct WebRTC peer-to-peer matches with no server required in default open-source builds. Pass `--relay wss://…` (or set `PAPIFA_RELAY_URL`) to bake an optional fallback relay into a custom build, or `--no-relay` to force a direct-only build.

## Setup

```bash
cd desktop
npm ci
```

`electron` and `electron-builder` are pinned to exact versions in `package.json` and `package-lock.json`.

## Building

Outputs default to `~/scratch/papifa/desktop-dist/` (Windows: `%USERPROFILE%\scratch\papifa\desktop-dist\`) — never inside the git repository.

```bash
cd desktop
npm run build
```

Platform defaults when no target flag is passed:
- **Windows:** builds the Windows x64 `portable .exe` natively (no Wine needed).
- **Linux:** builds Linux x64 (`AppImage` + `.tar.gz`) and Windows x64 (`portable .exe` when `wine` is on `PATH`, or `.zip` automatically when `wine` is absent).
- **macOS:** builds macOS `.zip` natively.

Useful options:

```bash
# Build a specific committed release ref
node build.mjs --ref 33acec1

# Build uncommitted edits in game/ (labelled "<commit>-dirty")
node build.mjs --worktree

# Build a single platform or override output directory
node build.mjs --linux --out /tmp/papifa-dist
node build.mjs --win --win-target zip
```

- **Linux AppImage without FUSE 2:** on distributions that only ship FUSE 3 (no `libfuse.so.2`), run the AppImage with `--appimage-extract-and-run` (or `APPIMAGE_EXTRACT_AND_RUN=1`), or extract and run the `.tar.gz` build.

## Headless smoke test (Linux)

Verify the packaged Linux build (custom origin, security flags, title menu, kickoff vs AI, and Gamepad API + tutorial step 1 via a virtual controller):

```bash
cd desktop
npm run smoke

# Test a specific artifact
node smoke.mjs --app ~/scratch/papifa/desktop-dist/Papifa-*.tar.gz
```

Screenshots are saved to `../assets-src/screens/desktop-smoke/` (git-ignored) unless `--out <dir>` is passed.
