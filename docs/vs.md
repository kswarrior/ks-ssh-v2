# KS SSH vs other web SSH tools

How KS SSH compares to `sshx.io` and the most popular web-first SSH / terminal-sharing tools.

> Scope: browser-first remote shell access. Classic OpenSSH client workflows
> (`ssh user@host`, `~/.ssh/config`, `scp`) are the baseline everything else builds on —
> this page compares what you get when you want it **in a browser** and/or **without
> opening ports**.

## How scoring works (100 pts total)

Scores are opinionated but transparent, weighted for **this doc's scope**
(browser + no-open-port + single-box management). Weights sum to 100:

| # | Criterion | Max | What earns full marks |
|---|---|---|---|
| A | NAT traversal / no open port | 20 | Outbound-only, works behind NAT/CGNAT, auto-reconnect |
| B | Browser access + share-by-link + mobile | 15 | Any browser opens it, one-tap share link, usable on a phone |
| C | Terminal quality (PTY, tabs, reattach) | 10 | Real PTY, resize, scrollback/reattach, multi-tab |
| D | E2E / transport security | 15 | Relay sees ciphertext only (or no relay to trust) |
| E | Files / ports / host panel | 10 | Beyond a shell: files, processes/ports, health, editor |
| F | Multi-user collaboration | 10 | Shared cursors / joint sessions / chat |
| G | Identity & audit (login, SSO/RBAC, recording) | 10 | Login gate → SSO/RBAC + session recording |
| H | Self-host simplicity | 10 | One binary / one container = done; no cluster ops |

Per-tool line format: `NAT · Web · Term · E2E · Panel · Collab · IdAudit · Self`
in the same A–H order, so you can verify the total yourself.
Scores reflect the **latest codebase in this repo** (see "What KS SSH actually is")
and the current public docs of each competitor (checked Sep 2026; `sshx` unchanged:
canvas + E2E + Fly mesh, self-host still discouraged).

## What KS SSH actually is (this repo)

Single static Rust binary + embedded web UI + Cloudflare relay:

- **Local mode:** `ks-ssh --port 8080` serves the UI on `127.0.0.1` (or `0.0.0.0`).
  Real PTY shell over WebSocket (`cli/backend/src/shell.rs`): sessions outlive the
  socket (reattach by id, 256 KB scrollback ring replay, 30 min detached TTL,
  max 64 sessions, takeover close `4000`), resize via `{"type":"resize"}`, binary
  PTY frames. Multi-tab xterm.js frontend with persisted tabs
  (`cli/frontend/src/pages/Terminal.tsx`, `ks-ssh:terms*` in `localStorage`).
- **Optional login gate (new vs older docs):** `--user/--pass` together protect the
  **local** UI (`cli/backend/src/auth.rs`, `cli/backend/src/main.rs:90-149`).
  Login page (`Login.tsx`), session cookie (`ks_ssh_auth`, 1 yr), extra users in
  Settings → Users (`Users.tsx`, salted SHA-256 in
  `$XDG_CONFIG_HOME/ks-ssh/users.json`, `0600`). Any logged-in user can create;
  edit/delete requires the **main** password; main account can only change
  password, never be renamed/deleted. Omit both flags = open access (previous
  behaviour). Auth does **not** cover the relay share link (see below).
- **Relay mode (no open port):** `ks-ssh --no-serve --token=ABCDE` dials **outbound
  WSS** to the Worker (`cli/backend/src/relay.rs`), registers a 5-char token, and
  pushes the whole frontend as a single-file HTML bundle (`ui-begin` / `ui-chunk` /
  `ui-end`, cached per token in a Durable Object). Open it at `/v/ABCDE` or
  `#/view/ABCDE` (`cf/worker/room.ts`, `cf/src/App.tsx`). `--token=` (empty)
  generates a random token; `--no-ui` skips the push; `--e2e-key=` reuses `k`;
  `--no-e2e` forces legacy plaintext. `?k=` in query is rejected (`400`) —
  `k` lives in the fragment only.
- **Beyond a shell:** Files (HOME-jailed browse / rename / mkdir / upload /
  fetch-by-URL via `curl`/`wget` / download / text editor with binary + 1 MB
  read-cap detection, 5 MB save cap, 100 MB upload/download cap), Ports (TCP/UDP
  from `/proc/net` + `ss` fallback, inode→PID map, kill by PID with
  TERM→KILL escalation, refuses PID 1/self), Host (hostname/OS/kernel/arch,
  uptime/load/proc count, per-core CPU %, RAM+swap, `df -kP -T` disks with
  pseudo-FS filtering, live graphs). See `cli/backend/src/files.rs`,
  `cli/backend/src/ports.rs`, `cli/backend/src/host.rs` and
  `cli/frontend/src/pages/Files.tsx`, `Ports.tsx`, `Host.tsx`.
- **Local-first + relay list:** connection/token list + settings in `localStorage`
  (`ks-ssh:ssh`, `ks-ssh:settings`), no account on the public site. CF site pages:
  Home / SSH (token cards + presence + E2E badge) / View (fullscreen `/v/TOKEN`
  iframe with WSS `srcdoc` fallback + live `ui-ready` reload) / Installation /
  Settings (`cf/src/App.tsx`).
- **One-line install:**
  `curl -sSfL .../cli/release/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh`.

Honest limits (visible in code today):

- Relay `data` messages are currently **acked, not bridged to a PTY**
  (`cli/backend/src/relay.rs` `on_text` — `PTY bridging comes next`). Full interactive
  shell over relay = open the pushed fullscreen UI (`/v/TOKEN`); the thin
  SSH-page session view is pairing/status only.
- Files / Ports / Host call the **local** backend (`/api/*`). Over the relay
  fullscreen view they show `Cannot reach the host … not over the relay view`.
  They work when the browser can reach the agent's HTTP port.
- Token = 5-char room ID (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`,
  `cli/backend/src/relay.rs:22`). Guessable by design — routing only.
  Secrecy comes from `k` (256-bit, fragment-only `#k=...`, never sent to the
  relay). Relay session payloads are `enc` (AES-256-GCM, AAD=token, HKDF-SHA256
  `ks-ssh-e2e-v1`, 96-bit random nonce, seq from 0, strict increment).
- Relay share link stays open to whoever holds it — `--user/--pass` protects the
  local UI only (`main.rs:237-239`).
- No multi-cursor collaboration, no session recording/audit, no SSO/RBAC.
  One Cloudflare Worker/Durable Object relay (`pair:<TOKEN>` rooms), not a global mesh.

## TL;DR comparison (with total score / 100)

| Tool | Type | NAT / no open port | Browser access | E2E encrypted | Multi-user collab | Files / host mgmt | Self-host | Score / 100 | Pick it when… |
|---|---|---|---|---|---|---|---|---|---|
| **KS SSH (this repo)** | Rust agent + CF relay + local web UI | ✅ outbound WSS | ✅ local UI + `/v/TOKEN` fullscreen | ✅ AES-256-GCM, key in fragment (sshx-style) | ❌ | ✅ Files + Ports + Host + editor | ✅ binary + Worker | **75** | You want one binary = shell **plus** file/ports/host panel, with a no-port share link |
| **OpenSSH baseline** | Classic client (`ssh`, `scp`) | ❌ needs reachable sshd | ❌ terminal client | ✅ SSH | ❌ (`tmux` DIY) | ⚠️ `scp`/`sftp` only | ✅ everywhere | **43** | Daily driving reachable hosts; the baseline everything else builds on |
| **sshx.io** (`ekzhang/sshx`) | Rust collab terminal + Fly.io mesh | ✅ outbound | ✅ link | ✅ Argon2+AES, key in fragment | ✅ canvas, cursors, chat | ❌ terminal only | ⚠️ discouraged / non-trivial | **69** | 2+ people pairing / teaching on one terminal |
| **tmate** | tmux fork + tmate.io relay | ✅ outbound SSH | ✅ web + SSH, ro/rw links | ❌ | ✅ shared tmux | ❌ | ✅ `tmate-server` | **54** | Fastest "look at this for 10 min" share, tmux-native |
| **upterm** | SSH session relay | ✅ outbound SSH | ❌ SSH client needed | ✅ SSH | ✅ shared session | ❌ | ✅ | **50** | CI debugging / SSH-only sharing, no browser |
| **ttyd** | C self-hosted web terminal | ❌ needs port/proxy | ✅ | ❌ (TLS via proxy) | ⚠️ view-only mirror | ❌ (+ZMODEM xfer) | ✅ trivial | **41** | LAN / VPS where you control ingress, simplest web shell |
| **wetty / GoTTY** | Node/Go web terminal + login/SSH | ❌ needs port/proxy | ✅ | ❌ (TLS via proxy) | ❌ | ❌ | ✅ | **33** | `ssh` in a browser tab behind your own reverse proxy |
| **Sshwifty** | Browser SSH/Telnet client | ❌ needs reachable sshd | ✅ + SFTP files | ✅ SSH | ❌ | ⚠️ SFTP files only | ✅ Docker | **46** | Emergency SSH from a borrowed browser, no agent install |
| **Apache Guacamole** | RDP/SSH/VNC gateway | ❌ (gateway needs ingress) | ✅ | ❌ (TLS to gateway) | ⚠️ connection sharing | ⚠️ remote files via SFTP | ✅ heavy | **44** | Enterprise clientless desktop + SSH fleet |
| **Teleport** | Identity access plane | ✅ reverse tunnel | ✅ | ✅ | ✅ joint sessions + recording | ⚠️ via SSH/SFTP/modes | ✅ heavy | **75** | Team SSO / RBAC / audit for SSH/K8s/DB |
| **Tailscale SSH / CF Tunnel / ZeroTier** | Mesh / tunnel network | ✅ outbound WG/QUIC | ⚠️ via Serve/other | ✅ WireGuard | ❌ | ⚠️ SFTP/SCP | ✅ account | **63** | Private fleet access without public ports, all nodes enrolled |
| **VS Code tunnels** | Editor + terminal tunnel | ✅ outbound to MS | ✅ vscode.dev | ✅ | ✅ Live Share | ✅ full editor | ☁️ MS-hosted | **76** | Full remote dev, not just a shell |

Ranked by score: VS Code tunnels 76 · KS SSH 75 = Teleport 75 · sshx 69 ·
Tailscale-family 63 · tmate 54 · upterm 50 · Sshwifty 46 · Guacamole 44 ·
OpenSSH 43 · ttyd 41 · wetty/GoTTY 33.
Weights favour browser + no-port (35/100), so pure-SSH tools score lower by design.

## Details

### 0. OpenSSH baseline — the reference (no browser, no relay)

`ssh user@host`, `~/.ssh/config`, `scp`/`sftp`. Still the best daily driver for
reachable hosts: mature keys/certs, multiplexing, `tmux`/`mosh` if you add them.

- Nothing to open in a browser, nothing to share by link, no NAT help.
- Security = SSH itself; identity = keys/certs you manage; no recording/audit
  out of the box.

**Score: 43/100** — NAT 2/20 · Web 0/15 · Term 10/10 · E2E 12/15 · Panel 3/10 ·
Collab 0/10 · IdAudit 6/10 · Self 10/10.

**KS SSH vs it:** keep OpenSSH for daily reachable-host work; use KS SSH when the
box is behind NAT or the viewer only has a browser/phone.

### 1. sshx.io — the closest comparison

**Score: 69/100** — NAT 19/20 · Web 14/15 · Term 9/10 · E2E 14/15 · Panel 0/10 ·
Collab 10/10 · IdAudit 1/10 · Self 2/10.

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
(files, ports, host health, editor, login gate + user management) plus a share
link with the same E2E shape (token routes, `#k=...` fragment seals, relay sees
ciphertext). KS SSH uses HKDF-SHA256 (not Argon2 — `k` is already 256-bit CSPRNG)
+ AES-256-GCM via WebCrypto / `aes-gcm`; UI bundle stays plaintext (public build
output). KS SSH outscores sshx here only because panel + self-host weigh 20 pts;
flip those weights and sshx wins.

### 2. tmate — the "just show someone" workhorse

**Score: 54/100** — NAT 17/20 · Web 11/15 · Term 7/10 · E2E 2/15 · Panel 0/10 ·
Collab 8/10 · IdAudit 2/10 · Self 7/10.

`tmate` forks tmux, dials out to `tmate.io`, prints 4 endpoints:
SSH read-write, SSH read-only, web read-write, web read-only.

- Zero firewall config, tmux semantics preserved, BSD-licensed, self-hostable
  relay (`tmate-ssh-server` + `tmate-slash`).
- No E2E (relay can theoretically see plaintext), terminal only, no server
  health/file UI, links are bearer secrets.

**KS SSH vs tmate:** tmate wins for instant ad-hoc pairing with tmux users.
KS SSH wins when you need persistent local UI (reattachable tabs, file/port/host
management, optional login) rather than a throwaway shared tmux.

### 3. upterm — SSH-only relay

**Score: 50/100** — NAT 16/20 · Web 2/15 · Term 6/10 · E2E 10/15 · Panel 0/10 ·
Collab 6/10 · IdAudit 3/10 · Self 7/10.

`upterm host -- bash` shares over an SSH relay; viewers use `ssh`, no browser.

- Smaller attack surface (no web renderer), scriptable, good for CI/RMA flows.
- No browser viewer, no file/host dashboard.

**KS SSH vs upterm:** upterm if viewers live in terminals and you distrust web
exposure. KS SSH if the viewer is a phone/browser.

### 4. ttyd — simplest self-hosted web shell

**Score: 41/100** — NAT 2/20 · Web 11/15 · Term 7/10 · E2E 3/15 · Panel 2/10 ·
Collab 2/10 · IdAudit 4/10 · Self 10/10.

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

**Score: 33/100** — NAT 2/20 · Web 10/15 · Term 6/10 · E2E 3/15 · Panel 0/10 ·
Collab 0/10 · IdAudit 4/10 · Self 8/10.

- **wetty** (Node): browser → `http(s)://host:3000` → `/bin/login` or `ssh
  [user@]localhost|remote`. Force-SSH, custom host/port/user flags. Put behind a
  reverse proxy for HTTPS.
- **GoTTY** (Go): same idea, `gotty -w ssh remote`, share a command over HTTP(S).

Like ttyd: no relay, no E2E sharing story, terminal only.

**KS SSH vs them:** wetty/GoTTY are thinner (just expose login/SSH). KS SSH is a
fuller homelab panel (persistent tabs + relay fallback + file/port/host APIs +
optional multi-user login).

### 6. Sshwifty — browser SSH client (no agent)

**Score: 46/100** — NAT 2/20 · Web 11/15 · Term 6/10 · E2E 10/15 · Panel 4/10 ·
Collab 0/10 · IdAudit 5/10 · Self 8/10.

Go + JS client at `sshwifty-demo.nirui.org` or self-hosted Docker. You type
host/user/password-or-key and get SSH + SFTP in the browser. Telnet too.

- Perfect for "borrowed laptop / tablet, need to reach my VPS now". Nothing
  installed on the server beyond `sshd`.
- Server must already be **reachable** (public IP / port forward / VPN). No relay
  for NAT boxes, no share-by-link, no host-metrics page.

**KS SSH vs Sshwifty:** Sshwifty connects *to* any sshd from the browser.
KS SSH installs *on* the box and gives it a link + dashboard.

### 7. Apache Guacamole — enterprise clientless gateway

**Score: 44/100** — NAT 3/20 · Web 12/15 · Term 6/10 · E2E 4/15 · Panel 4/10 ·
Collab 4/10 · IdAudit 8/10 · Self 3/10.

Java + `guacd`, MySQL/LDAP/OIDC, RDP+VNC+SSH in HTML5, connection sharing,
recording, SFTP file browser.

- Powerful for fleets/VDI, but heavy: servlet container, DB, proxy, hardening.
- Gateway itself needs ingress; not a NAT-traversal agent.

**KS SSH vs Guacamole:** Guacamole for org-wide browser access to many hosts.
KS SSH for one box, one binary, zero infra (at the cost of no SSO/fleet story).

### 8. Teleport — identity-aware access plane

**Score: 75/100** — NAT 17/20 · Web 12/15 · Term 8/10 · E2E 13/15 · Panel 4/10 ·
Collab 8/10 · IdAudit 10/10 · Self 3/10.

SSO/OIDC + short-lived certs, RBAC, per-session MFA (`tsh`), joint sessions,
full session recording, `scp`/SFTP, K8s/DB/app proxy, browser UI.

- Best audit story of the list. Cost: cluster ops (auth/proxy/nodes or Cloud),
  agents on every node.

**KS SSH vs Teleport:** Teleport when compliance / team access reviews matter
(ties KS SSH here on points, wins outright once audit weight rises).
KS SSH when you want `curl … && ./ks-ssh` and done — plus a HOME-jailed
file editor and host panel Teleport doesn't try to be.

### 9. Tailscale SSH / Cloudflare Tunnel / ZeroTier — private nets

**Score: 63/100** — NAT 18/20 · Web 6/15 · Term 7/10 · E2E 14/15 · Panel 3/10 ·
Collab 0/10 · IdAudit 9/10 · Self 6/10.

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

**Score: 76/100 (VS Code tunnels)** — NAT 18/20 · Web 13/15 · Term 8/10 ·
E2E 12/15 · Panel 9/10 · Collab 7/10 · IdAudit 7/10 · Self 2/10.

- **Termius / Blink / JuiceSSH / Mobile SSH:** mature keyboards, keys on device,
  Mosh support. Still need a reachable `sshd`.
- **VS Code tunnels / code-server / Jupyter:** full editor + terminal over an
  outbound tunnel (`vscode.dev`), heavier than a shell link.
- **ShellHub / MeshCentral / RustDesk / Pangolin / bore / rathole:** device
  management or raw TCP exposure — pair with ttyd/wetty when you need ingress.

**KS SSH vs them:** keep your native SSH app for daily driving reachable hosts;
use KS SSH relay links for NAT boxes and phone-browser triage. VS Code tunnels
top this table because "full editor + tunnel" covers the most criteria — at the
price of a Microsoft account and zero self-host points.

### KS SSH (this repo) — scored on the same rubric

**Score: 75/100** — NAT 18/20 · Web 14/15 · Term 8/10 · E2E 12/15 · Panel 10/10 ·
Collab 0/10 · IdAudit 4/10 · Self 9/10.

Where the points come from: outbound WSS with reconnect + single-file UI push
(A); local UI + `/v/TOKEN` fullscreen + mobile (B); real PTY with reattach ring
+ multi-tab + resize (C); AES-256-GCM `enc` with fragment-only `k`, HKDF, AAD,
seq, `?k=` rejection (D); full Files/Ports/Host + editor panel (E); optional
`--user/--pass` login + Users page (part of G); one binary + one Worker (H).
Where they leak: no collaboration (F = 0); no SSO/RBAC/recording and relay link
unaffected by login (G = 4); single relay + PTY-not-yet-bridged over the thin
relay view + plaintext UI bundle by design (small deductions in A/B/D).

## When to choose KS SSH

- Homelab / VPS / IoT behind NAT, and you want **one binary** for shell + files
  + ports + host health without opening ports.
- Phone-first triage: share link → fullscreen UI, no SSH client/keys on the phone.
- Demos/support where the other side just opens a URL.
- You already run Cloudflare and want the relay to see only ciphertext sizes.
- You want a tiny login gate (`--user/--pass` + Users page) without SSO infra.

## E2E (sshx-style)

- `token` (5-char) routes; `k` (256-bit, `#k=...` fragment only) seals.
  `hello` negotiates `{e2e:"aes-gcm-v1"}`; sensitive payloads are `enc`
  (AES-256-GCM, nonce 96-bit random, AAD=token, seq from 0, strict increment).
- Relay learns NOTHING except room existence + sizes/timing. UI bundle
  (`ui-begin/chunk/end`, `/v/TOKEN`) stays PLAINTEXT (public build output).
- Legacy peers (no `e2e` in `hello`) fall back to plaintext with a
  `⚠️ relay-visible` banner; `--no-e2e` forces legacy. Missing `k` in the
  browser prompts `Paste the full link with #k=...` (never fetched/stored).
- `--e2e-key=` reuses a key across restarts; otherwise `--token=` generates a
  fresh `k` per run. A `?k=` query is rejected — fragment only.

## When not to

- Multiplayer pairing with live cursors/chat → **sshx**.
- Throwaway tmux share with SSH viewers → **tmate**.
- Compliance (recording, SSO, RBAC, audit) → **Teleport / Tailscale SSH**.
- Pure LAN web shell with existing ingress → **ttyd**.
- SSH to arbitrary existing hosts from a random browser → **Sshwifty**.
- Full remote dev (editor + terminal + Live Share) → **VS Code tunnels**.
- Legacy `--no-e2e` sessions where the relay can see plaintext (use only for
  debugging).

## Quick start (KS SSH)

```sh
curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh \
  && chmod +x ks-ssh \
  && ./ks-ssh            # local UI at http://127.0.0.1:8080

./ks-ssh --user admin --pass '…'        # local UI behind a login gate (+ Users page)
./ks-ssh --no-serve --token=ABCDE   # relay only, prints share links with #k=...
#   E2E: ON — Share link: https://<relay>/v/ABCDE#k=<SECRET>
#                + https://<relay>/#/view/ABCDE#k=<SECRET>
./ks-ssh --token=ABCDE              # local UI + relay agent together
./ks-ssh --no-serve --token= --no-ui  # relay without pushing fullscreen UI
./ks-ssh --no-serve --token=ABCDE --no-e2e  # legacy plaintext (relay-visible)
```

Security notes: tokens are short-lived room IDs (guessable) — rotate by
restarting with a fresh `--token=`; `k` is the real secret (fragment only,
never query/log/store). `--user/--pass` protects the local UI only; the relay
link stays bearer-open to whoever holds it. Manual check: share text over the
relay, wipe Worker storage, confirm relay logs contain only `enc` sizes. Prefer
`--host 127.0.0.1` unless you mean to expose the LAN; Files APIs are jailed
to `$HOME` (1 MB editor read cap, 5 MB save cap, 100 MB transfer cap) and Ports
kill is PID-scoped (refuses PID 1/self, TERM→KILL), but without `--user/--pass`
the local UI itself has no auth gate, so don't bind `0.0.0.0` on untrusted
networks without a reverse-proxy auth layer.
