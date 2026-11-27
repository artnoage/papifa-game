# Building Papifa Yourself

You only need two free tools to build the Papifa desktop app on your own computer: **Node.js (LTS)** and **Git**. No compilers, Python, or shell utilities are required.

---

## Windows (build your own `.exe`)

### 1. Install Node.js and Git (one-time setup)
1. Download and install **Node.js (LTS)** from <https://nodejs.org/>. Keep all default options during installation.
2. Download and install **Git for Windows** from <https://git-scm.com/downloads/win>. Keep all default options.
3. Close any open terminal windows so Windows picks up both tools.

### 2. Download Papifa and build the `.exe`
Open **PowerShell** (press the Windows key, type `PowerShell`, and press Enter), then run these four commands one by one:

```powershell
git clone https://github.com/artnoage/papifa-game.git
cd papifa-game\desktop
npm ci
npm run build
```

- The first build downloads Electron and the vendored Three.js files (around 150 MB total) and takes a couple of minutes.
- Everything builds natively on Windows — no Wine or extra tools needed.

### 3. Find and run the `.exe`
When the build finishes, your single-file app is saved to:

```text
%USERPROFILE%\scratch\papifa\desktop-dist\Papifa-0.1.0-<commit>-win-x64-portable.exe
```

To open that folder in File Explorer straight from PowerShell:

```powershell
explorer "$env:USERPROFILE\scratch\papifa\desktop-dist"
```

Double-click the `.exe` to play.

- **Windows SmartScreen notice:** because this self-built `.exe` is not digitally signed, Windows may show *"Windows protected your PC"*. Click **More info** → **Run anyway**.
- **Fullscreen:** press **F11** at any time to toggle fullscreen.
- **Controller:** plug in an Xbox, PlayStation, or standard USB/Bluetooth gamepad before or during play.

---

## Linux

### 1. Install Node.js (LTS) and Git
Use your distribution's package manager (for example `sudo apt install nodejs npm git` on Ubuntu/Debian, or `sudo pacman -S nodejs npm git` on Arch).

### 2. Build
```bash
git clone https://github.com/artnoage/papifa-game.git
cd papifa-game/desktop
npm ci
npm run build
```

This writes the packages to `~/scratch/papifa/desktop-dist/`:
- `Papifa-0.1.0-<commit>-linux-x86_64.AppImage`
- `Papifa-0.1.0-<commit>-linux-x64.tar.gz`
- `Papifa-0.1.0-<commit>-win-x64-portable.exe` (built if `wine` is on `PATH`; otherwise a `.zip` archive is built automatically)

To build Linux only: `npm run build:linux`.

**Running on Linux:**
- Make the AppImage executable (`chmod +x Papifa-*.AppImage`) and run it. If your distro only ships FUSE 3 (error mentioning `libfuse.so.2`), run it with `./Papifa-*.AppImage --appimage-extract-and-run`, or extract and run the `.tar.gz` archive instead.

---

## macOS

1. Install **Node.js (LTS)** from <https://nodejs.org/> and **Git** (via `xcode-select --install` or Homebrew).
2. Open **Terminal** and run:

```bash
git clone https://github.com/artnoage/papifa-game.git
cd papifa-game/desktop
npm ci
npm run build
```

The zipped macOS app (`Papifa-0.1.0-<commit>-mac-<arch>.zip`) is written to `~/scratch/papifa/desktop-dist/`.

---

## Optional: build a specific version or your own local edits

- **Build a specific commit:**
  ```bash
  node build.mjs --ref <commit-sha>
  ```
- **Build uncommitted edits in `game/`:**
  ```bash
  node build.mjs --worktree
  ```
  Worktree builds are labelled `<commit>-dirty` so you can tell them apart from clean releases.
- **Stage only the static web release (no Electron):**
  ```bash
  node scripts/build-web.mjs --stage ./staged-web
  ```
  Add `--worktree` to include uncommitted edits from `game/`.

---

## Online play in self-built copies

Self-built web and desktop copies need **no game server**: **Host online** generates a short invite code (`P1I-…`), the guest pastes it in **Join online** and sends back a reply code (`P1R-…`), and the host pastes the reply to open a direct WebRTC peer-to-peer match.

- **Network & IP note:** direct WebRTC uses public STUN servers (`stun.l.google.com` and `stun.cloudflare.com`) to find reachable addresses, so both players and the STUN servers see each other's IP addresses. Very strict mobile data or office/school Wi-Fi networks can block direct peer-to-peer links; try another network if a match cannot connect.
