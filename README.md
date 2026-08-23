# KS SSH

**KS SSH** is a modern, open-source web-based SSH client and server manager. It gives you a real terminal, file manager, code editor, port tools and live monitoring for any VM, VPS or container — directly in the browser. Open one link and manage everything.

## Features

### Web Terminal
- Real PTY shell over WebSocket with xterm.js
- Unlimited terminal tabs, split panes (VS Code style)
- On-screen key bar (ESC, TAB, BKSP, CTRL, ALT, arrows) with on/off toggle
- Reconnect without losing scrollback, themes and font settings

### Host & Connection Management
- Password, private key and agent-forward authentication
- Connection test + known-hosts fingerprint verification
- Groups/tags, search, `~/.ssh/config` import
- Secrets encrypted at rest, never exposed via API

### File Manager
- Full SFTP browser: upload (local or by URL), download, create, rename, move, copy, delete
- Folder download auto-zipped server-side; multi-select → delete or download as `.zip`
- Per-type file icons, human-readable sizes, permissions editor (chmod)
- Bookmarks for pinned paths per host
- Transfer manager with queue, pause/resume and progress

### Code Editor
- Monaco editor (the engine behind VS Code) with syntax colors per file type
- Markdown files open with Edit / Preview split
- Save back over SFTP with automatic backup and diff-before-save
- Multiple file tabs, quick-open (`Ctrl+P`), recent files

### Ports & Tunnels
- Live listening-port list per host with inline Kill button (approval dialog)
- Port preview: any remote HTTP port opens at `{ks-ssh-url}/port/preview/{port}`
  — proxied over SSH, no firewall changes needed, WebSocket pass-through
- Local (L), remote (R) and dynamic SOCKS5 tunnels with auto-reconnect

### Server Ops
- Resource monitor: CPU, RAM, disk, network, load average with live charts
- System info panel: OS, kernel, arch, virtualization type (KVM/OpenVZ/LXC/Docker)
- Git panel: status, diff, commit, branches — real git over SSH
- Docker panel: containers, logs, exec-into-container terminal
- Systemd services, cron table editor, live log viewer (`tail -f` with filters)

### Power Tools
- Command palette (`Ctrl+Shift+P`), global search & replace across remote files
- Command snippets library + multi-exec on many hosts at once
- Session restore (hot exit): terminals, tabs and layout survive reloads
- Ping indicator with green/yellow/red latency badge
- Session audit log, optional asciicast recording and replay

### Platform
- Multi-user teams: admin / operator / viewer roles, shared hosts, per-user audit
- App login with 2FA (TOTP), HTTPS-ready, rate-limited auth
- Notification center, customizable shortcuts, dark/light themes
- Mobile responsive + installable PWA
- Ships as a **single static binary** — frontend embedded

## Quick Start

### Requirements
- Linux host (Ubuntu 22.04+, Debian 12+, or similar)
- Go 1.22+ (for building from source)
- Node.js 20+ (for frontend development)
- Any target machine you can reach with normal SSH

### Installation

```bash
# Clone and build
git clone https://github.com/your-org/ks-ssh.git
cd ks-ssh
make build

# Run
./ks-ssh

# Open in browser
http://localhost:8090
```

### Development
```bash
make dev   # Go backend + Vite dev server with hot reload
```

### Environment
```text
PORT=8090
DATA_DIR=./data
SECRET_KEY=change_me
```

## Documentation

- [Plan & Feature Spec](plan.md)
- [Agent Rules](loop.md)

## Community

- Issues: [GitHub Issues](https://github.com/your-org/ks-ssh/issues)
- Discussions: [GitHub Discussions](https://github.com/your-org/ks-ssh/discussions)

## License

MIT License — see [LICENSE](LICENSE) for details.

---

**Your servers. One link away.**
