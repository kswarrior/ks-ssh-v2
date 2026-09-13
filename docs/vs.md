# KS SSH vs other web SSH tools

How KS SSH compares to `sshx.io` and the most popular web-first SSH / terminal-sharing tools.

> Scope: browser-first remote shell access. Classic OpenSSH client workflows
> (`ssh user@host`, `~/.ssh/config`, `scp`) are the baseline everything else builds on —
> this page compares what you get when you want it **in a browser** and/or **without
> opening ports**.

## What KS SSH actually is (this repo)

Single static Rust binary + embedded web UI + Cloudflare relay:

- **Local mode:** `ks-ssh --port 8080` serves the UI on `127.0.0.1` (or `0.0.0.0`).
  Real PTY shell over WebSocket (`cli/backend/src/shell.rs`), multi-tab xterm.js
  frontend (`cli/frontend/src/pages/Terminal.tsx`).
- **Relay mode (no open port):** `ks-ssh --no-serve --token=ABCDE` dials **outbound
  WSS** to the Worker (`cli/backend/src/relay.rs`), registers a 5-char token, and
  pushes the whole frontend as a single-file HTML bundle (`ui-begin` / `ui-chunk` /
  `ui-end`, cached per token in a Durable Object). Open it at `/v/ABCDE` or
  `#/view/ABCDE` (`cf/worker/room.ts`, `cf/src/App.tsx`).
- **Beyond a shell:** Files (HOME-jailed browse / rename / mkdir / upload /
  fetch-by-URL / download / text editor), Ports (TCP/UDP scan + kill by PID),
  Host (CPU / RAM / disk / uptime / load, live graphs). See
  `cli/backend/src/files.rs`, `cli/backend/src/ports.rs`,
  `cli/backend/src/host.rs` and `cli/frontend/src/pages/Files.tsx`,
  `cli/frontend/src/pages/Ports.tsx`, `cli/frontend/src/pages/Host.tsx`.
- **Local-first:** connection list + settings in `localStorage`, no account,
  light/dark + mobile UI, one-line install:
  `curl -sSfL .../cli/release/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh`.

Honest limits (visible in code today):

- Relay `data` messages are currently **acked, not bridged to a PTY**
  (`cli/backend/src/relay.rs:206` — `PTY bridging comes next`). Full interactive
  shell over relay = open the pushed fullscreen UI (`/v/TOKEN`); the thin
  SSH-page session view is pairing/status only.
- Files / Ports / Host call the **local** backend (`/api/*`). Over the relay
  fullscreen view they show `Cannot reach the host … not over the relay view`.
  They work when the browser can reach the agent's HTTP port.
- Token = 5-char room ID (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
  `cli/backend/src/relay.rs:15`). Guessable by design — routing only.
  Secrecy comes from `k` (256-bit, fragment-only `#k=...`, never sent to the
  relay). Relay session payloads are `enc` (AES-256-GCM, AAD=token).
- No multi-cursor collaboration, no session recording/audit, no SSO/RBAC.
  One Cloudflare Worker/Durable Object relay, not a global mesh.

## TL;DR comparison

| Tool | Type | NAT / no open port | Browser access | E2E encrypted | Multi-user collab | Files / host mgmt | Self-host | Pick it when… |
|---|---|---|---|---|---|---|---|---|
| **KS SSH (this repo)** | Rust agent + CF relay + local web UI | ✅ outbound WSS | ✅ local UI + `/v/TOKEN` fullscreen | ✅ AES-256-GCM, key in fragment (sshx-style) | ❌ | ✅ Files + Ports + Host + editor | ✅ binary + Worker | You want one binary = shell **plus** file/ports/host panel, with a no-port share link |
| **sshx.io** (`ekzhang/sshx`) | Rust collab terminal + Fly.io mesh | ✅ outbound | ✅ link | ✅ Argon2+AES, key in fragment | ✅ canvas, cursors, chat | ❌ terminal only | ⚠️ discouraged / non-trivial | 2+ people pairing / teaching on one terminal |
| **tmate** | tmux fork + tmate.io relay | ✅ outbound SSH | ✅ web + SSH, ro/rw links | ❌ | ✅ shared tmux | ❌ | ✅ `tmate-server` | Fastest "look at this for 10 min" share, tmux-native |
| **upterm** | SSH session relay | ✅ outbound SSH | ❌ SSH client needed | ✅ SSH | ✅ shared session | ❌ | ✅ | CI debugging / SSH-only sharing, no browser |
| **ttyd** | C self-hosted web terminal | ❌ needs port/proxy | ✅ | ❌ (TLS via proxy) | ⚠️ view-only mirror | ❌ (+ZMODEM xfer) | ✅ trivial | LAN / VPS where you control ingress, simplest web shell |
| **wetty / GoTTY** | Node/Go web terminal + login/SSH | ❌ needs port/proxy | ✅ | ❌ (TLS via proxy) | ❌ | ❌ | ✅ | `ssh` in a browser tab behind your own reverse proxy |
| **Sshwifty** | Browser SSH/Telnet client | ❌ needs reachable sshd | ✅ + SFTP files | ✅ SSH | ❌ | ⚠️ SFTP files only | ✅ Docker | Emergency SSH from a borrowed browser, no agent install |
| **Apache Guacamole** | RDP/SSH/VNC gateway | ❌ (gateway needs ingress) | ✅ | ❌ (TLS to gateway) | ⚠️ connection sharing | ⚠️ remote files via SFTP | ✅ heavy | Enterprise clientless desktop + SSH fleet |
| **Teleport** | Identity access plane | ✅ reverse tunnel | ✅ | ✅ | ✅ joint sessions + recording | ⚠️ via SSH/SFTP/modes | ✅ heavy | Team SSO / RBAC / audit for SSH/K8s/DB |
| **Tailscale SSH / CF Tunnel / ZeroTier** | Mesh / tunnel network | ✅ outbound WG/QUIC | ⚠️ via Serve/other | ✅ WireGuard | ❌ | ⚠️ SFTP/SCP | ✅ account | Private fleet access without public ports, all nodes enrolled |
| **VS Code tunnels** | Editor + terminal tunnel | ✅ outbound to MS | ✅ vscode.dev | ✅ | ✅ Live Share | ✅ full editor | ☁️ MS-hosted | Full remote dev, not just a shell |

## Details

### 1. sshx.io — the closest comparison

`curl -sSf https://sshx.io/get | sh` then `sshx` → shareable `https://sshx.io/s/...` link.

- Infinite canvas, resizable panes, live cursors + names, chat, predictive echo
  (Mosh-style), auto-reconnect + latency estimate, global Fly.io + Redis mesh.
- Real E2E encryption: session key derived client-side (URL fragment never hits
  the server), Argon2 + AES. Relay sees ciphertext.
- Great for teaching / multi-person debugging / CI (`... | sh -s run` in Actions).
- Trade-offs: terminal **only** (no file manager, port list, host stats),
  ephemeral sessions (ends with the process), self-hosting officially
  discouraged (needs gRPC + TLS + Redis + mesh ops), Windows PTY still maturing,
  no recording/replay.

**KS SSH vs sshx:** pick sshx for multiplayer terminal collaboration
(canvas, cursors, chat). Pick KS SSH when you want a personal server panel
(files, ports, host health, editor) plus a share link with the same E2E shape
(token routes, `#k=...` fragment seals, relay sees ciphertext). KS SSH uses
HKDF-SHA256 (not Argon2 — `k` is already 256-bit CSPRNG) + AES-256-GCM via
WebCrypto / `aes-gcm`; UI bundle stays plaintext (public build output).

### 2. tmate — the "just show someone" workhorse

`tmate` forks tmux, dials out to `tmate.io`, prints 4 endpoints:
SSH read-write, SSH read-only, web read-write, web read-only.

- Zero firewall config, tmux semantics preserved, BSD-licensed, self-hostable
  relay (`tmate-ssh-server` + `tmate-slash`).
- No E2E (relay can theoretically see plaintext), terminal only, no server
  health/file UI, links are bearer secrets.

**KS SSH vs tmate:** tmate wins for instant ad-hoc pairing with tmux users.
KS SSH wins when you need persistent local UI + file/port/host management
rather than a throwaway shared tmux.

### 3. upterm — SSH-only relay

`upterm host -- bash` shares over an SSH relay; viewers use `ssh`, no browser.

- Smaller attack surface (no web renderer), scriptable, good for CI/RMA flows.
- No browser viewer, no file/host dashboard.

**KS SSH vs upterm:** upterm if viewers live in terminals and you distrust web
exposure. KS SSH if the viewer is a phone/browser.

### 4. ttyd — simplest self-hosted web shell

`ttyd -p 7681 bash` → `http://host:7681`. xterm.js, CJK/IME, SSL, basic auth,
`-R` read-only, `-o` once, ZMODEM transfer.

- One tiny binary, trivial behind nginx/Caddy/Traefik + Let's Encrypt.
- **Needs inbound reachability** (port forward / reverse proxy / VPN). No relay,
  no NAT traversal, no link sharing, no collaboration cursors, no
  files/ports/host dashboard.

**KS SSH vs ttyd:** ttyd if you already have ingress and only need a shell in a
tab. KS SSH if the box is behind NAT/CGNAT/hotel Wi-Fi and you need outbound-only
access plus management pages.

### 5. wetty / GoTTY — web login / SSH frontends

- **wetty** (Node): browser → `http(s)://host:3000` → `/bin/login` or `ssh
  [user@]localhost|remote`. Force-SSH, custom host/port/user flags. Put behind a
  reverse proxy for HTTPS.
- **GoTTY** (Go): same idea, `gotty -w ssh remote`, share a command over HTTP(S).

Like ttyd: no relay, no E2E sharing story, terminal only.

**KS SSH vs them:** wetty/GoTTY are thinner (just expose login/SSH). KS SSH is a
fuller homelab panel with relay fallback.

### 6. Sshwifty — browser SSH client (no agent)

Go + JS client at `sshwifty-demo.nirui.org` or self-hosted Docker. You type
host/user/password-or-key and get SSH + SFTP in the browser. Telnet too.

- Perfect for "borrowed laptop / tablet, need to reach my VPS now". Nothing
  installed on the server beyond `sshd`.
- Server must already be **reachable** (public IP / port forward / VPN). No relay
  for NAT boxes, no share-by-link, no host-metrics page.

**KS SSH vs Sshwifty:** Sshwifty connects *to* any sshd from the browser.
KS SSH installs *on* the box and gives it a link + dashboard.

### 7. Apache Guacamole — enterprise clientless gateway

Java + `guacd`, MySQL/LDAP/OIDC, RDP+VNC+SSH in HTML5, connection sharing,
recording, SFTP file browser.

- Powerful for fleets/VDI, but heavy: servlet container, DB, proxy, hardening.
- Gateway itself needs ingress; not a NAT-traversal agent.

**KS SSH vs Guacamole:** Guacamole for org-wide browser access to many hosts.
KS SSH for one box, one binary, zero infra.

### 8. Teleport — identity-aware access plane

SSO/OIDC + short-lived certs, RBAC, per-session MFA (`tsh`), joint sessions,
full session recording, `scp`/SFTP, K8s/DB/app proxy, browser UI.

- Best audit story of the list. Cost: cluster ops (auth/proxy/nodes or Cloud),
  agents on every node.

**KS SSH vs Teleport:** Teleport when compliance / team access reviews matter.
KS SSH when you want `curl … && ./ks-ssh` and done.

### 9. Tailscale SSH / Cloudflare Tunnel / ZeroTier — private nets

- **Tailscale SSH:** WireGuard tailnet + IdP identity, ACLs, check-mode step-up,
  `tsrecorder` session recording, SFTP/SCP. No key juggling, no public ports —
  but every viewer needs Tailscale enrolled.
- **Cloudflare Tunnel (`cloudflared`):** outbound QUIC to Cloudflare edge, then
  `cloudflare access ssh` / browser-rendered SSH with Access policies. Great
  ingress-free sharing, tied to Cloudflare account/Zero Trust.
- **ZeroTier / Netmaker / Pangolin:** same pattern — overlay net, then plain SSH.

**KS SSH vs them:** overlays win for a private fleet with identity policy.
KS SSH wins for a public-style "send this link, open in any browser" flow with
no client install and a built-in management UI.

### 10. Native apps + editor tunnels

- **Termius / Blink / JuiceSSH / Mobile SSH:** mature keyboards, keys on device,
  Mosh support. Still need a reachable `sshd`.
- **VS Code tunnels / code-server / Jupyter:** full editor + terminal over an
  outbound tunnel (`vscode.dev`), heavier than a shell link.
- **ShellHub / MeshCentral / RustDesk / Pangolin / bore / rathole:** device
  management or raw TCP exposure — pair with ttyd/wetty when you need ingress.

**KS SSH vs them:** keep your native SSH app for daily driving reachable hosts;
use KS SSH relay links for NAT boxes and phone-browser triage.

## When to choose KS SSH

- Homelab / VPS / IoT behind NAT, and you want **one binary** for shell + files
  + ports + host health without opening ports.
- Phone-first triage: share link → fullscreen UI, no SSH client/keys on the phone.
- Demos/support where the other side just opens a URL.
- You already run Cloudflare and want the relay to see only ciphertext sizes.

## E2E (sshx-style)

- `token` (5-char) routes; `k` (256-bit, `#k=...` fragment only) seals.
  `hello` negotiates `{e2e:"aes-gcm-v1"}`; sensitive payloads are `enc`
  (AES-256-GCM, nonce 96-bit random, AAD=token, seq from 0, strict increment).
- Relay learns NOTHING except room existence + sizes/timing. UI bundle
  (`ui-begin/chunk/end`, `/v/TOKEN`) stays PLAINTEXT (public build output).
- Legacy peers (no `e2e` in `hello`) fall back to plaintext with a
  `⚠️ relay-visible` banner; `--no-e2e` forces legacy. Missing `k` in the
  browser prompts `Paste the full link with #k=...` (never fetched/stored).

## When not to

- Multiplayer pairing with live cursors/chat → **sshx**.
- Throwaway tmux share with SSH viewers → **tmate**.
- Compliance (recording, SSO, RBAC, audit) → **Teleport / Tailscale SSH**.
- Pure LAN web shell with existing ingress → **ttyd**.
- SSH to arbitrary existing hosts from a random browser → **Sshwifty**.
- Legacy `--no-e2e` sessions where the relay can see plaintext (use only for
  debugging).

## Quick start (KS SSH)

```sh
curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh \
  && chmod +x ks-ssh \
  && ./ks-ssh            # local UI at http://127.0.0.1:8080

./ks-ssh --no-serve --token=ABCDE   # relay only, prints share links with #k=...
#   E2E: ON — Share link: https://<relay>/v/ABCDE#k=<SECRET>
#                + https://<relay>/#/view/ABCDE#k=<SECRET>
./ks-ssh --token=ABCDE              # local UI + relay agent together
./ks-ssh --no-serve --token= --no-ui  # relay without pushing fullscreen UI
./ks-ssh --no-serve --token=ABCDE --no-e2e  # legacy plaintext (relay-visible)
```

Security notes: tokens are short-lived room IDs (guessable) — rotate by
restarting with a fresh `--token=`; `k` is the real secret (fragment only,
never query/log/store). Manual check: share text over the relay, wipe Worker
storage, confirm relay logs contain only `enc` sizes. Prefer
`--host 127.0.0.1` unless you mean to expose the LAN; Files APIs are jailed
to `$HOME` and Ports kill is PID-scoped, but the local UI itself has no auth
gate, so don't bind `0.0.0.0` on untrusted networks without a reverse-proxy
auth layer.
