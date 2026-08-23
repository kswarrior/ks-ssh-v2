# KS SSH — Web-Based SSH Client & Server Manager

Build **KS SSH**, a self-hosted web UI for managing servers over SSH: real terminal,
file manager, code editor and port tools — close to a browser VS Code.
Open it once in the browser; everything runs from a link.

**Product rule:** every feature must survive reloads, disconnects and restarts.
State lives server-side in SQLite; the browser is a view, not the source of truth.

## 1. Stack

* Backend: **Go 1.22+**
  * SSH: `golang.org/x/crypto/ssh` · SFTP: `github.com/pkg/sftp`
  * WebSocket: `gorilla/websocket` · HTTP router: `chi`
  * SQLite: **pure-Go `modernc.org/sqlite`** (CGO-free → true single binary)
  * Config: env + SQLite settings table
* Frontend: **React 18 + TypeScript** (Vite), state via zustand
* Terminal: **xterm.js** (+ WebGL renderer) · Editor: **Monaco**
* Deploy: single static binary, frontend embedded via `go:embed`
* Web UI: `http://localhost:8090`

```text
ks-ssh/
├── apps/web/          # React frontend
├── apps/server/       # Go backend
│   ├── cmd/ks-ssh/    # entrypoint
│   └── internal/      # ssh, sftp, ws, api, store, proxy, tunnels
├── packages/types/    # shared contracts (TS types generated from Go)
├── scripts/           # dev/build helpers
└── data/
```

## 2. Core Features

### 2.1 Connections (Hosts)
* Add/edit/delete hosts: name, host, port, username, labels/color
* Auth: password · private key (+ passphrase) · key uploaded & stored encrypted ·
  SSH-agent forwarding · per-host override of app defaults
* **Jump host / bastion chains** (host A via host B)
* Connection test before save; known-hosts verify with TOFU prompt +
  fingerprint change warning (block on mismatch unless user accepts)
* Groups/tags, global search, connect from list, last-used + status badges
* Store secrets AES-256-GCM encrypted at rest (`SECRET_KEY`),
  never returned via API, never logged
* Concurrent-session cap per host (default 10, configurable)

### 2.2 Web Terminal
* Real PTY shell over WebSocket (resize-aware, flow-control aware)
* **VS Code-style terminal system**:
  * unlimited terminal tabs (`+` new, `x` kill, rename)
  * split active terminal right / down (drag divider to resize)
  * terminals keep running server-side while hidden or tab closed —
    background PTYs survive browser close until killed or host disconnects
* Flexible panel splits like VS Code: the workspace is a movable grid —
  a terminal can share space with **file manager**, **ports**, or another
  terminal in any combination; panels drag & drop into any cell;
  layout persisted per host
* Reconnect without losing scrollback (server keeps ring buffer,
  replays last N lines + sequence numbers to detect gaps)
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
* Search files by name/glob (server-side, respects symlink safety)
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
  rename, move, copy, delete, download, permissions, open in editor,
  extract archive (.zip/.tar.gz)
* **Click file name/card → opens in editor** (text/code) with type-aware
  icon + syntax color; binary files offer download only
* Transfers run through the transfer manager (queue, pause/resume, retry),
  chunked over WS with checksum verification; resume partial uploads
* Symlink safety: no traversal outside resolved root of the operation target

### 2.4 Code Editor
* Open any remote text file → Monaco, **syntax colors per file type**
  (js/ts/py/go/json/yml/html/css/sh/dockerfile/… auto-detected by extension + shebang)
* **Markdown support**: `.md` opens with Edit / Preview split —
  rendered markdown (headings, lists, tables, code blocks) beside the source
* Save back over SFTP, timestamped backup before overwrite (kept N versions)
* Diff view before save, large-file guard (> 2 MB opens read-only by default)
* Multiple files = editor tabs; unsaved-changes indicator; auto-save toggle
* Quick-open (Ctrl+P) across remote project folders
* Opened files auto-reload when changed remotely (file watcher via SFTP stat polling)
* Breadcrumbs, minimap, find-in-file, go-to-line, format-on-save

### 2.5 Ports & Processes
* List listening ports per host (`ss -tlnp` parse, `netstat` fallback):
  port, PID, process name, bind address, protocol (tcp/udp)
* Inline **Kill** button per row (with approval dialog + audit entry);
  PID re-validated server-side at kill time (no stale-PID kills)
* Inline **Preview** button per HTTP port → opens:

```text
{ks-ssh-base-url}/port/preview/{port}
e.g. https://ssh.example.com/port/preview/5050
```

* Preview = built-in HTTP proxy: KS SSH forwards requests from that URL to the
  remote host's local port over the SSH connection — no open firewall ports needed
* Preview supports WebSocket pass-through, base-path rewriting option,
  and one-click "open in new tab"
* Preview requires app login + per-host enable switch (off by default);
  blocks loopback to KS SSH itself
* Detect which app uses which port; refresh on demand + auto every 10 s

### 2.6 Tunnels / Forwarding
* Local forward (L), remote forward (R), dynamic SOCKS5
* Tunnel list: create/start/stop/auto-reconnect with exponential backoff
* Bind-address validation (refuse binding app-wide ports unintentionally)
* Active connections + traffic counters; tunnel health dot in sidebar
* Tunnels persist across app restarts and reconnect independently

### 2.7 Monitoring (per host)
* Metrics collected by one exec channel reading `/proc` + `df`
  (no agents installed on remote); fallback parse of `vmstat`/`free`
* CPU, RAM, disk, network live charts (1 s resolution, 1 h window in memory)
* Uptime, load average, OS info
* Top processes table (CPU/RAM sort, kill from here too)
* Header monitor button opens this as overlay without leaving workspace

### 2.8 Command Tools
* Command snippets library (run with one click, per host or global)
* Shell command history per session (searchable)
* Multi-exec: run one snippet on N hosts, outputs side by side,
  per-host exit codes, stop-all button
* Dangerous-command patterns (rm -rf /, mkfs, dd to disk…) flagged pre-run

### 2.9 Sessions & Audit
* Session list: who connected where, when, duration
* Optional session recording (asciicast) + replay player
* Audit log of destructive actions (delete, chmod, kill, service restart,
  tunnel change): who, what, where, when, result — append-only
* Audit export (JSON/CSV)

### 2.10 Header Actions (top-right, 3 SVG icon buttons)

```text
┌──────────────────────────────────────────────────────┐
│ [⌨svg] KS SSH ((wifi)) 24ms   [host selector]  [ⓘ][📊][⚙] │
│        KS Warrior                                     │
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
* Recent files & recent paths per host
* Fully customizable keyboard shortcuts
* Themes: dark/light + accent color, terminal themes, Monaco themes

**Workspace**
* Session restore (hot exit): reload reopens same terminals, editor tabs,
  key-bar state and panel layout — persisted per host
* Zen mode (fullscreen single pane), collapsible sidebars

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
┌──────────────────────────────────────────────────────────┐
│ [⌨svg] KS SSH  ((wifi)) 24ms   [host selector]  [ⓘ][📊][⚙] │
│        KS Warrior                                         │
├─────────┬────────────────────────────┬───────────────┬────┤
│ HOSTS   │ TERMINAL / EDITOR tabs     │ FILES         │ ⋮  │
│ groups  │                            │ tree          │    │
│  host A │  tab1  tab2  tab3          │ upload        │    │
│  host B │  ┌─────────┬─────────┐     │ permissions   ├────┤
│         │  │ shell   │ shell   │     │               │MON │
│ TUNNELS │  └─────────┴─────────┘     ├───────────────┤    │
│ PORTS   │                            │ MONITOR       │    │
└─────────┴────────────────────────────┴───────────────┴────┘
```

Desktop-first, black/white developer theme, 5px radius (match ks-agent look).
All panels are movable grid cells (§2.2).

## 4. Backend Architecture

```text
HTTP/WS API (Go, chi)
├── /api/auth            login, users, 2FA, sessions
├── /api/hosts           CRUD + test connection + import ssh_config
├── /api/terminal        WS: PTY stream (in/out/resize/replay)
├── /api/files           SFTP ops (REST) + WS transfer progress/chunks
├── /api/editor          read/write remote file, diff, backups
├── /api/search          global grep + replace
├── /api/ports           listening ports, kill
├── /port/preview/{port} HTTP+WS reverse proxy → remote port (over SSH)
├── /api/tunnels         CRUD + status + traffic counters
├── /api/monitor         metrics poll (WS stream)
├── /api/snippets        CRUD + multi-run (WS fan-out)
├── /api/git             status/stage/commit/log/branch/push/pull
├── /api/docker          containers, logs, exec attach (WS)
├── /api/services        systemd units + actions
├── /api/cron            crontab read/edit
├── /api/logs            tail -f streams (WS)
├── /api/bookmarks       CRUD per host
└── /api/sessions        audit, recordings, replay
```

### WS message envelope (all sockets)

```json
{ "type": "pty.in|pty.out|pty.resize|ws.ping|transfer.chunk|…",
  "seq": 123, "ts": 1699999999999, "payload": { … } }
```

Sequence numbers let the client detect gaps after reconnect and request replay.

### Concurrency model

* One SSH client per open host session; multiplex shell/sftp/exec channels
  over the same TCP connection
* Keepalives every 15 s; dead-peer detection ≤ 45 s; auto-reconnect with
  backoff (1s→30s max), channels rebuilt transparently
* Per-host channel cap (default 20); transfer queue serializes heavy SFTP work
* All remote command output capped (ring buffer); slow clients get backpressure,
  never unbounded memory

SQLite tables:

```text
users, user_secrets(2fa, keys), roles,
hosts, host_groups, host_credentials(encrypted),
known_hosts, bookmarks, snippets,
tunnels, transfers,
sessions_audit(append-only), recordings,
editor_backups, app_settings
```

## 5. Security

* App login required (JWT in HttpOnly Secure SameSite cookie); HTTPS-ready,
  enforce option behind reverse proxy
* Secrets (passwords/passphrases/private keys) AES-256-GCM encrypted at rest
  with `SECRET_KEY`; never logged, never returned by any API, redacted in errors
* CSRF protection on mutating routes; strict CSP; security headers
* Auth rate limiting + temporary lockout after repeated failures
* Path traversal + symlink protection in every SFTP/editor endpoint;
  URL-upload allows only http(s), blocks private/link-local targets (SSRF guard)
* Preview proxy + tunnels authenticated and per-host gated
* Kill/delete/chmod/service actions: explicit confirm dialog + server-side
  re-validation + append-only audit entry
* Host-key mismatch = hard block until user explicitly accepts new fingerprint
* Structured logs contain zero credentials; log level configurable

## 6. Reliability

* Graceful shutdown: drain WS connections, checkpoint transfers, flush SQLite (WAL)
* Server crash recovery: background PTYs/tunnels/transfers restored from state
  on boot where possible; client auto-resyncs via seq numbers
* Every WS client reconnect is idempotent (session token + replay window)
* Data dir layout: `data/ks-ssh.db`, `data/backups/`, `data/recordings/`,
  `data/keys/` — safe to rsync/backup

## 7. Performance Targets

* Terminal keystroke round-trip overhead < 10 ms beyond raw network RTT
* File listing of 10k entries < 500 ms (paginated)
* App binary < 40 MB; idle RAM < 100 MB per server instance
* 50 concurrent terminals on one 2-vCPU box without degradation

## 8. Milestones

```text
M1  Skeleton: Go server + React shell + auth + hosts CRUD + test connection
      ✓ accept: login, add host, connect, disconnect cleanly
M2  Terminal: SSH → xterm.js, tabs, splits, resize, reconnect+replay
      ✓ accept: survives 30s network cut mid-typing, no lost output
M3  File manager: browse/upload/download/multi-select/zip/URL upload
      ✓ accept: 1 GB upload resumable; folder zip streamed correctly
M4  Editor: Monaco open/save/diff/markdown/backup/watch
      ✓ accept: external change detected, backup created on save
M5  Ports & processes + tunnels + preview proxy
      ✓ accept: preview works with WS app; kill validated; tunnel survives restart
M6  Monitor, snippets, multi-exec, ping indicator
      ✓ accept: metrics live at 1 s; multi-exec shows per-host results
M7  Audit/recording, settings, themes, packaging (single binary, CGO-free)
      ✓ accept: fresh-machine build runs with only ./ks-ssh
M8  Power: command palette, global search, git panel, hot exit restore
      ✓ accept: F5 restores exact workspace
M9  Ops panels: docker, services, cron, logs + teams/2FA/PWA
      ✓ accept: role viewer cannot trigger destructive actions
```

## 9. Commands

```text
make dev      # go run + vite dev (hot reload both sides)
make build    # CGO_ENABLED=0 single binary, frontend embedded
make test     # go test ./... + web typecheck/lint
./ks-ssh      # serves UI on :8090
```

Env:

```text
PORT=8090                 # listen port
DATA_DIR=./data           # sqlite + files
SECRET_KEY=change_me      # encryption key for stored secrets (required)
LOG_LEVEL=info            # debug|info|warn|error
MAX_SESSIONS_PER_HOST=10  # concurrent SSH sessions per host
ENABLE_PREVIEW=false      # port preview proxy default per install
```

## 10. Critical Requirement

No mock features. The following must be genuinely functional:

```text
Real SSH sessions        Real PTY streaming      Real SFTP transfers
Real zip streaming       Real tunnels (L/R/SOCKS) Real port kill
Real preview proxy       Real metrics from /proc  Real git/docker/systemd ops
Real encrypted secrets   Real audit trail         Real session restore
Real reconnect + replay  Real multi-exec          Real recordings/replay
```

Build KS SSH as a **real, modular, extensible server-management platform** —
the best web SSH UI there is — not a demo.

Keep the architecture ready for future:

```text
Mosh support        S3/backup integration    plugin system
AI assistant hooks  shared team terminals    mobile push notifications
```
