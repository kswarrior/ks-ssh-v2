# KS SSH — Web-Based SSH Client & Server Manager

Build **KS SSH**, a self-hosted web UI for managing servers over SSH: real terminal,
file manager, code editor and port tools — close to a browser VS Code.
Open it once in the browser; everything runs from a link.

## 1. Stack

* Backend: **Go** (`x/crypto/ssh`, `pkg/sftp`, `gorilla/websocket`)
* Frontend: **React + TypeScript** (Vite)
* Terminal: **xterm.js** · Editor: **Monaco**
* Storage: SQLite (better-sqlite3 via sidecar or pure-Go `modernc.org/sqlite`)
* Deploy: single static binary + embedded frontend
* Web UI: `http://localhost:8090`

```text
ks-ssh/
├── apps/web/          # React frontend
├── apps/server/       # Go backend
├── packages/types/    # shared contracts
└── data/
```

## 2. Core Features (short)

### 2.1 Connections (Hosts)
* Add/edit/delete hosts: name, host, port, username
* Auth: password, private key (+ passphrase), agent forwarding
* Connection test, known-hosts fingerprint verify
* Groups/tags, search, connect from list
* Store secrets encrypted at rest, never return them via API

### 2.2 Web Terminal
* Real PTY shell over WebSocket (resize-aware)
* **VS Code-style terminal system**:
  * unlimited terminal tabs (`+` new, `x` kill, rename)
  * split active terminal right / down (drag divider to resize)
  * terminals keep running while hidden in background tabs
* Flexible panel splits like VS Code: the workspace is a movable grid —
  a terminal can share space with **file manager**, **ports**, or another
  terminal in any combination; panels drag & drop into any cell
* Reconnect without losing scrollback
* Themes, font size, copy/paste, keyboard shortcuts
* On-screen key bar rendered at the **top of each terminal pane** (not in the app header),
  so every new terminal/split gets its own bar:

```text
┌ terminal pane ────────────────────────────────────────┐
│ [ESC] [TAB] [BKSP] [CTRL] [ALT] [↑] [↓] [←] [→]  [⏻] │
├───────────────────────────────────────────────────────┤
│ $ _                                                   │
└───────────────────────────────────────────────────────┘
```

* Keys send real escape sequences over WebSocket
* CTRL / ALT are sticky modifiers: tap `CTRL` then `C` → sends Ctrl+C
* `[⏻]` = on/off toggle for the key bar on the bar itself;
  remembered per terminal + global default in Settings

### 2.3 File Manager (SFTP)
* Browse remote FS: tree + list views
* Upload (drag & drop, multi-file), download, progress bars
* New file/folder, rename, move, copy, delete (recycle confirm)
* Permissions editor (chmod octal), owner/group display
* **Icons**: every file type gets its own SVG icon with type color
  (`.js` `.ts` `.py` `.go` `.json` `.yml` `.html` `.css` `.sh` `.md`
  `.zip` `.img` … like VS Code icon themes); all folders use one single
  folder icon; unknown types get a generic file icon
* Size column: human-readable file sizes (B/KB/MB/GB); folders show item count,
  full size on demand
* Download: files download directly; **folders auto-zip server-side**
  (streamed as `.zip`, no temp files left on remote)
* **Multi-select**: checkboxes / ctrl+click / shift-range select files+folders
  together → floating action bar: delete (confirm), download as single `.zip`,
  move, copy, total size preview
* Search files by name/glob
* **Toolbar buttons with dropdowns**:

```text
[ ⬆ Upload ▾ ]  [ ＋ Create ▾ ]  [ ☆ Bookmarks ▾ ]

Upload ▾   → ① From local (file picker / drag & drop)
            ② From URL  (KS SSH downloads server-side → SFTP writes it)

Create ▾   → ① New folder   (inline name input)
            ② New file      (opens in editor after create)

Bookmarks ▾→ pinned paths/files per host, jump + pin current path,
             rename/remove bookmarks
```

* **3-dot menu (⋮)** on every file/folder row & card:
  rename, move, copy, delete, download, permissions, open in editor
* **Click file name/card → opens in editor** (text/code) with type-aware
  icon + syntax color; binary files offer download only

### 2.4 Code Editor
* Open any remote text file → Monaco, **syntax colors per file type**
  (js/ts/py/go/json/yml/html/css/sh/dockerfile/… auto-detected by extension)
* **Markdown support**: `.md` opens with Edit / Preview split —
  rendered markdown (headings, lists, tables, code blocks) beside the source
* Save back over SFTP, backup before overwrite
* Diff view before save, large-file guard
* Multiple files = editor tabs; unsaved-changes indicator
* Quick-open (Ctrl+P) across remote project folders

### 2.5 Ports & Processes
* List listening ports per host (`ss`/`netstat` parse): port, PID, name, address
* Inline **Kill** button per row (with approval dialog + audit entry)
* Inline **Preview** button per HTTP port → opens:

```text
{ks-ssh-base-url}/port/preview/{port}
e.g. https://ssh.example.com/port/preview/5050
```

* Preview = built-in HTTP proxy: KS SSH forwards requests from that URL to the
  remote host's local port over the SSH connection — no open firewall ports needed
* Preview supports WebSockets pass-through, base-path rewriting option,
  and one-click "open in new tab"
* Detect which app uses which port

### 2.6 Tunnels / Forwarding
* Local forward (L), remote forward (R), dynamic SOCKS5
* Tunnel list: create/start/stop/auto-reconnect
* Active connections + traffic counters

### 2.7 Monitoring (per host)
* CPU, RAM, disk, network live charts (poll via one SSH channel)
* Uptime, load average, OS info
* Top processes table

### 2.8 Command Tools
* Command snippets library (run with one click, per host or global)
* Shell command history per session
* Multi-exec: run one snippet on N hosts, see outputs side by side

### 2.9 Sessions & Audit
* Session list: who connected where, when, duration
* Optional session recording (asciicast) + replay
* Audit log of destructive actions (delete, chmod, kill)

### 2.10 Header Actions (top-right, 3 SVG icon buttons)

```text
┌──────────────────────────────────────────────────────┐
│ KS SSH   [host selector]            [ⓘ info] [📊 mon] [⚙] │
```

* **System Info** (ⓘ): modal/drawer with everything about the connected
  VM / VPS / container — OS + version, kernel, arch, hostname, uptime,
  CPU model/cores, total RAM/disk, virtualization type (KVM/OpenVZ/LXC/Docker),
  public IP, distro logo
* **Resource Monitor** (📊): live panel — CPU %, RAM usage, disk usage,
  network in/out, load average, top processes (charts from §2.7)
* **Settings** (⚙): opens the Settings page

Buttons act on the currently selected host; disabled until a host is connected.

* **Top-left brand**: SVG SSH logo (terminal/chevron icon) with `KS SSH` title
  and small subtitle text below: `KS Warrior`
* **Ping indicator** (top-left, right after `KS SSH`): wifi-style SVG icon,
  small ms value below it, colored by latency:

```text
  KS SSH  ((wifi))   [host selector]
          24ms
```

```text
green  < 100 ms
yellow 100–300 ms
red    > 300 ms / timeout
```

* Measures real RTT over the SSH channel (keepalive echo), updates every few seconds;
  tooltip shows min/avg/max; click → latency history sparkline

### 2.11 VS Code-Level Power Features

**Navigation & editing**
* Command palette (`Ctrl+Shift+P`): every action/host/file searchable
* Global search & replace across remote project (server-side grep),
  grouped results → click opens file at exact line
* Breadcrumbs above editor, minimap, find-in-file, go-to-line
* Multiple cursors, format-on-save, auto-save toggle (Monaco built-ins)
* Opened files auto-reload when changed on the server (file watcher)
* Recent files & recent paths per host

**Workspace**
* Session restore (hot exit): reload reopens same terminals, editor tabs,
  key-bar state and panel layout — persisted per host
* Zen mode (fullscreen single pane), collapsible sidebars
* Fully customizable keyboard shortcuts
* Themes: dark/light + accent color, terminal themes, Monaco themes

**Server ops panels**
* **Git panel**: status, staged changes, diff viewer, commit, log,
  branch switch, pull/push (runs real git over SSH)
* **Docker panel**: container list + status, start/stop/restart,
  logs viewer, exec-into-container (opens terminal in container)
* **Services panel**: systemd units with green/red dots,
  start/stop/restart/enable (approval dialog)
* **Cron panel**: view/edit crontab entries in a safe table UI
* **Log viewer**: live `tail -f` with pause, filter regex, highlight, download

**Files & transfers**
* Extract archives (.zip/.tar.gz) from 3-dot menu
* Drag & drop files inside tree to move
* Image / video / audio / PDF preview tabs
* Transfer manager: queue, progress, speed, pause/resume, retry failed

**Terminal upgrades**
* Search inside scrollback, clickable links/paths, WebGL renderer
* Paste-warning for multiline commands (bracketed paste)

**Platform**
* Import `~/.ssh/config` + known-hosts management UI
* Multi-user teams: roles admin / operator / viewer, shared hosts,
  per-user sessions + audit
* App 2FA (TOTP), HTTPS enforced option
* Notification center: transfer done, tunnel down, host offline
* Mobile responsive + installable PWA

## 3. UI Layout

```text
┌──────────────────────────────────────────────────────┐
│ [⌨svg] KS SSH   [host selector]      [ⓘ] [📊] [⚙]    │
│  KS Warrior                                           │
├─────────┬────────────────────────────┬───────────────┤
│ HOSTS   │ TERMINAL / EDITOR tabs     │ FILES         │
│ groups  │                            │ tree          │
│  host A │  tab1  tab2  tab3          │ upload        │
│  host B │  ┌─────────┬─────────┐     │ permissions   │
│         │  │ shell   │ shell   │     ├───────────────┤
│ TUNNELS │  └─────────┴─────────┘     │ MONITOR       │
│ PORTS   │                            │ cpu/mem/net   │
└─────────┴────────────────────────────┴───────────────┘
```

Desktop-first, black/white developer theme, 5px radius (match ks-agent look).

## 4. Backend Architecture

```text
HTTP/WS API (Go)
├── /api/auth          login, users
├── /api/hosts         CRUD + test connection
├── /api/terminal      WS: PTY stream (in/out/resize)
├── /api/files         SFTP ops (REST) + WS transfer progress
├── /api/editor        read/write remote file, diff
├── /api/ports         listening ports, kill
├── /port/preview/{port}  HTTP+WS reverse proxy → remote host port (over SSH)
├── /api/tunnels       CRUD + status
├── /api/monitor       metrics poll
├── /api/snippets      CRUD + multi-run (WS)
└── /api/sessions      audit, recordings
```

One SSH client per open session; multiplex channels (shell, sftp, exec)
over the same TCP connection.

SQLite tables:

```text
users, hosts, host_groups, sessions_audit,
snippets, tunnels, settings
```

## 5. Security

* App login required (JWT/session cookie); HTTPS ready
* Secrets (passwords/passphrases/keys) encrypted at rest, never logged
* Path traversal protection in SFTP endpoints
* Dangerous actions (kill, delete, chmod) need explicit confirm + audit entry
* Rate-limit auth endpoints; fail closed everywhere

## 6. Milestones

```text
M1  Skeleton: Go server + React app + auth + hosts CRUD
M2  Terminal: SSH → xterm.js, tabs, resize
M3  File manager: SFTP browse/upload/download/rename/delete
M4  Editor: Monaco open/save/diff
M5  Ports & processes + tunnels
M6  Monitor, snippets, multi-exec
M7  Audit/recording, settings, polish, packaging (single binary)
M8  Power: command palette, global search, git panel, session restore
M9  Ops panels: docker, services, cron, logs + teams/2FA/PWA
```

## 7. Commands

```text
make dev      # go run + vite dev
make build    # single binary, frontend embedded
./ks-ssh      # serves UI on :8090
```

Env:

```text
PORT=8090
DATA_DIR=./data
SECRET_KEY=change_me
```

## 8. Critical Requirement

No mock features. Real SSH, real SFTP transfers, real PTY streaming,
real tunnels, real process kills, real persistence.
