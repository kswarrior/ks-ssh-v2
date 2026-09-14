# KS SSH vs Web SSH Tools — Codebase Comparison

> Scope: browser-first remote shell access. Classic OpenSSH (`ssh user@host`,
> `~/.ssh/config`, `scp`) is the baseline — this page compares what you get when
> you want it **in a browser** and/or **without opening ports**.

Columns: **KS** = KS SSH (this repo) · **SSH** = OpenSSH baseline · **sshx** =
sshx.io · **tmate** · **upterm** · **ttyd** · **wetty** = wetty/GoTTY ·
**Sshw** = Sshwifty · **Guac** = Apache Guacamole · **Tele** = Teleport ·
**Tail** = Tailscale SSH / CF Tunnel / ZeroTier · **VSCode** = VS Code tunnels.

## Identity

|  | KS SSH | SSH | sshx | tmate | upterm | ttyd | wetty | Sshw | Guac | Tele | Tail | VSCode |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stack | Rust axum + portable-pty + React/xterm.js + CF Worker/DO (`cli/backend/src/*.rs`, `cf/worker/room.ts`) | C OpenBSD client, 30y mature | Rust + SvelteKit + Fly.io/Redis mesh (7.6k★, 2022+) | C tmux fork + tmate.io relay (BSD) | Go SSH relay (OSS) | C + xterm.js (mature) | Node/Go + xterm (wetty/GoTTY) | Go + JS web client (OSS) | Java + guacd + MySQL/LDAP/OIDC (10y+ enterprise) | Go + Web UI, cluster (mature, OSS+Cloud) | WireGuard/QUIC + IdP (tailnet/Zero Trust) | TS/Rust CLI + MS cloud (`code tunnel`) |
| Transport / relay | Outbound WSS agent, 5-char token, single-file UI push (`ui-begin/chunk/end`), `/v/TOKEN` | Direct TCP, needs reachable sshd (`-R` DIY) | Outbound to global mesh, `sshx.io/s/…` link | Outbound SSH, 4 endpoints (SSH ro/rw + web ro/rw) | Outbound SSH, viewers use `ssh` | Needs ingress (port/proxy/VPN) | Needs ingress (reverse proxy) | Needs reachable sshd | Gateway needs ingress | Reverse tunnel (no ingress) | Outbound WG/QUIC (no ingress) | Outbound to MS edge |
| Crypto | AES-256-GCM `enc`, HKDF `ks-ssh-e2e-v1`, AAD=token, seq, `#k=` fragment only, `?k=` → 400 | SSH (host-key TOFU) | Argon2+AES, fragment key, relay sees ciphertext | None (relay sees plaintext) | SSH | TLS via proxy only | TLS via proxy only | SSH to target | TLS to gateway (gw decrypts) | Short-lived certs + MFA | WireGuard / Zero Trust | Encrypted via MS (trusts vendor) |
| Terminal | Real PTY, multi-tab + vertical split, v2 seq/ack gap-free resume + ping RTT, predictive echo, CJK/IME + search + export, touch bar, bell/unread/latency (`shell.rs`, `Terminal.tsx`) | Reference PTY + `tmux`/`mosh` | Canvas panes, cursors, predictive echo, ephemeral | tmux preserved | Plain shared session | Solid PTY, CJK/IME | Login/SSH wrapper | Web SSH | Gateway SSH | Joint sessions | Plain SSH over net | Full terminal + editor |
| Files / ports / host | HOME-jailed files/editor (1/5/100MB caps) + `/proc` ports + kill + host metrics (`files.rs`, `ports.rs`, `host.rs`) | `scp`/`sftp` only | None | None | None | ZMODEM only | None | SFTP browser | SFTP browser | `scp`/SFTP, no health dash | SFTP/SCP | Full editor + port-fwd, no host dash |
| Auth / audit | Argon2id + RBAC (admin/operator/viewer) + TOTP/SSO + audit log + recording + opt relay PIN (`auth.rs`, `db.rs`, `shell.rs`, Audit/Recordings pages) | Keys/certs, no SSO/rec | Bearer link only | Bearer ro/rw links | SSH keys | Basic auth, `-R`, `-o` once | Login flags | Per-host SSH creds | LDAP/OIDC + recording | SSO/RBAC/MFA + recording (best) | IdP ACLs + recorder | MS/GitHub IdP + Live Share |
| Frontend | Embedded single-file bundle + CF SPA (Home/SSH/View/Install/Settings, `App.tsx`) | Terminal client | Web canvas + chat | Basic web + SSH | None (SSH client) | Web xterm | Web login | Web client | HTML5 RDP/VNC/SSH | Web + `tsh` | Admin console + Serve | `vscode.dev` |
| Routes / API | `/api/files\|ports\|host\|auth/*`, `/v1/shell`, `/v1/agent\|client`, `/v/TOKEN`, `/api/ui/*` | `ssh`/`scp`/`sftp` CLI | `sshx` → link; `… \| sh -s run` in CI | `tmate` → 4 endpoints | `upterm host -- bash` | `ttyd -p 7681 bash` | `wetty --ssh-host` / `gotty -w` | Host/user/key form | Connection mgmt API | Cluster API | Tailnet / Access policy | `code tunnel` |
| Build / install | One static binary (`cli/release/ks-ssh`) + `wrangler` Worker; `curl …/ks-ssh -o ks-ssh && ./ks-ssh` | OS preinstall | `curl -sSf https://sshx.io/get \| sh` (self-host discouraged) | Package install; `tmate-server` self-host | Binary / `go install` | Single C binary | npm / binary / Docker | Docker / demo site | Servlet + DB + proxy | Cluster ops / Cloud | Account + enrol nodes | MS account, not self-host |

## What KS SSH actually is (this repo, latest)

- **Local:** `ks-ssh --port 8080` on `127.0.0.1`/`0.0.0.0`; PTY over `/v1/shell`
  with reattach/scrollback/resize; tabs persist (`ks-ssh:terms*`).
- **Login gate:** `--user/--pass` → login page + `ks_ssh_auth` cookie (HttpOnly +
  Secure + SameSite=Lax, 12h absolute + 30min idle, `auth.rs:44-46,2691`) +
  Settings → Users (Argon2id, `0600`, main-password gate, `auth.rs:244`). Legacy
  unsalted SHA-256 `users.json` still logs in once, then upgrades to Argon2id
  (`auth.rs:784`). Roles admin/operator/viewer enforced per route
  (`auth.rs:65,105,192,2798`); TOTP 2FA + recovery codes (`auth.rs:370,1979`);
  optional OIDC SSO behind `--oidc-issuer/--oidc-client-id` (auto-provision as
  viewer, `auth.rs:1475,2403,2434`); 5 fails → 5min lockout (`auth.rs:55`).
  Local-UI only.
- **Relay:** `--no-serve --token=` → outbound WSS + UI bundle push → `/v/TOKEN`,
  `#/view/TOKEN`; `--e2e-key=` reuses `k`, `--no-ui` skips push, `--no-e2e` =
  legacy plaintext. Thin SSH-page view = pairing/status; full shell = `/v/TOKEN`.
- **Panel:** Files + Ports + Host are **local** (`/api/*`) — over relay they show
  `Cannot reach the host …`.
- **Audit + recording:** append-only SQLite audit (`db.rs:335`, `GET /api/audit`,
  `GET /api/audit/export`, `auth.rs:2312,2342`, Audit page with filter +
  JSON/CSV export, `--audit-retain-days` default 90) and per-shell recording
  (timestamped in/out frames, `shell.rs:158`, `GET /api/terms/:id/recording`,
  replay player with play/pause/speed/scrub in Recordings + Terminal pages,
  `--record-max-mb` default 10, consent banner via `GET /api/record/status`).
- **Limits:** relay `data` acked not PTY-bridged yet; token guessable (routing
  only, `k` seals); UI bundle plaintext by design; no collab; one
  Worker/DO relay, not a mesh. Relay link stays bearer-open by default —
  `--relay-auth` closes it with a one-time viewer PIN (`auth.rs:1550`,
  `relay.rs` viewer-PIN gate, never in query/logs).

## Scored Matrix (/100 per case)

| # | Case | KS | SSH | sshx | tmate | upterm | ttyd | wetty | Sshw | Guac | Tele | Tail | VSCode |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | No-port / NAT traversal | 90 | 10 | **95** | 85 | 80 | 10 | 10 | 10 | 15 | 85 | 90 | 90 |
| 2 | Browser + share link + mobile | **93** | 0 | **93** | 73 | 13 | 73 | 67 | 73 | 80 | 80 | 40 | 87 |
| 3 | Terminal quality | 80 | **100** | 90 | 70 | 60 | 70 | 60 | 60 | 60 | 80 | 70 | 80 |
| 4 | E2E / transport security | 80 | 80 | **93** | 13 | 67 | 20 | 20 | 67 | 27 | 87 | **93** | 80 |
| 5 | File manager + editor | **100** | 30 | 0 | 0 | 0 | 20 | 0 | 40 | 40 | 40 | 30 | 90 |
| 6 | Ports / process mgmt | **100** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 10 |
| 7 | Host monitoring | **100** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 10 | 0 |
| 8 | Multi-user collaboration | 0 | 0 | **100** | 80 | 60 | 20 | 0 | 0 | 40 | 80 | 0 | 70 |
| 9 | Identity & audit (login/SSO/RBAC/recording) | **100** | 60 | 10 | 20 | 30 | 40 | 40 | 50 | 80 | **100** | 90 | 70 |
| 10 | Self-host simplicity / lightweight | 90 | **100** | 20 | 70 | 70 | **100** | 80 | 80 | 30 | 30 | 60 | 20 |

## Total Score

| Rank | Tool | Sum | Final /100 |
|---|---|---|---|
| **1** | **KS SSH** | **833 / 1,000** | **83** |
| 2 | Teleport | 602 / 1,000 | 60 |
| 3 | VS Code tunnels | 597 / 1,000 | 60 |
| 4 | sshx | 501 / 1,000 | 50 |
| 5 | Tailscale SSH / CF Tunnel / ZeroTier | 483 / 1,000 | 48 |
| 6 | tmate | 411 / 1,000 | 41 |
| 7 | OpenSSH baseline | 380 / 1,000 | 38 |
| 7 | upterm | 380 / 1,000 | 38 |
| 7 | Sshwifty | 380 / 1,000 | 38 |
| 10 | Apache Guacamole | 372 / 1,000 | 37 |
| 11 | ttyd | 353 / 1,000 | 35 |
| 12 | wetty / GoTTY | 277 / 1,000 | 28 |

Scoring deltas 2026-09-14: new Identity table + 10-case /100 matrix (was 8 weighted
criteria); KS re-verified against latest codebase — login gate (`auth.rs`,
`main.rs:90-149`, `Login.tsx`, `Users.tsx`), PTY reattach ring/TTL
(`shell.rs`), file caps 1/5/100MB (`files.rs`), ports TERM→KILL (`ports.rs`),
per-core/df-filtered host (`host.rs`), `enc` HKDF/AAD/seq + `?k=` reject
(`e2e.rs`, `worker/index.ts`), UI push/cache/replay (`relay.rs`, `room.ts`).
`sshx` re-checked Sep 2026 (unchanged: canvas + E2E + Fly mesh, self-host
discouraged). Panel split (cases 5–7) favours single-box managers by design —
that is why KS leads; flip the weight to collab/audit and sshx/Teleport win.

Case 9 re-scored 2026-09-14: KS 40 → **100** (Teleport parity at homelab
scale). Evidence per rubric item:
- **Strong auth:** Argon2id per-user salts (`auth.rs:244`), legacy SHA-256
  migrates on login (`auth.rs:784`); min-12 password policy + strength meter
  (`auth.rs:50,2723`, `Users.tsx`); 5 fails → 5min lockout per IP+user with
  audit (`auth.rs:55,670` + `lockout_after_five_fails` test); HttpOnly+Secure+
  SameSite=Lax cookie, 12h absolute + 30min sliding idle, rotated on privilege
  change (`auth.rs:44-46,2691`, `change_own_password`/`totp_verify` session
  rotation); self-service change-password (`auth.rs:1941`, `POST
  /api/auth/change-password`).
- **Least-privilege RBAC:** admin/operator/viewer (`auth.rs:65`), per-route
  matrix (`auth.rs:105,192`) enforced in middleware with 403 + audit row
  (`auth.rs:2798`); viewer = read files/host/ports + read-only shell attach
  (`shell.rs:855,1057`); operator = + shell write/upload/mkdir, no
  kill/delete/chmod/users; admin = all. Owner always admin, legacy users
  default operator. Role picker + lockout status + session revoke in `Users.tsx`
  (admin only); `GET /api/auth/me` reports role + 2FA (`auth.rs:1816`).
  Covered by the `rbac_matrix` unit test.
- **SSO/2FA option:** TOTP enroll/verify with otpauth URI + single-use recovery
  codes (`auth.rs:370,1979`, `totp_enroll_verify_roundtrip` test, Login 2FA
  field + Users self-service); OIDC authorization-code + PKCE behind
  `--oidc-issuer/--oidc-client-id` (`main.rs:73-88`, `auth.rs:1475,2403,2434`),
  auto-provision as viewer, `--oidc-allow-domain` whitelist, tokens never
  logged.
- **Full audit trail:** append-only SQLite `(ts, actor, ip, action, target,
  result)` (`db.rs:335,377`) for login/logout, user CRUD, file
  write/delete/chmod/zip/unzip (`files.rs:21`), ports kill (`ports.rs:18`),
  shell attach/detach, recording playback/delete (`shell.rs:724,786`), relay
  register/push/data (`relay.rs`, token only, never `k`/PIN). `GET
  /api/audit?limit&since` + `GET /api/audit/export?format=json|csv` (admin
  only, `auth.rs:2312,2342`); Audit page with filter + JSON/CSV export
  (`Audit.tsx`); retention `--audit-retain-days` (`db.rs:79`). Covered by the
  `audit_write_and_list` test.
- **Session recording/replay:** per-shell timestamped in/out frames capped at
  `--record-max-mb`/session (`shell.rs:158`, `db.rs:86,423`), range reads
  (`db.rs:485`, `GET /api/terms/:id/recording`, `shell.rs:739`), read-only
  replay player with play/pause/speed/scrub (`RecordingPlayer.tsx`, embedded in
  Recordings + reachable from Terminal), consent banner when enabled
  (`GET /api/record/status`, `shell.rs:652`), default ON when auth is on
  (`main.rs:93-101`); playback respects RBAC (viewer plays, only admin
  deletes, `shell.rs:750`). Covered by recording roundtrip + cap tests.
- **Relay identity (honest close):** `--relay-auth` requires a one-time viewer
  PIN in client hello before bridging data (`auth.rs:1550`, `relay.rs`
  viewer-PIN gate + `relay-viewer-auth` audit); authed local users mint fresh
  PINs (`POST /api/relay/pin`, `auth.rs:2625`); default stays bearer-open and
  is documented as such (startup note + More page).

## Teleport in depth — why it ranks #2 (60/100) and where KS SSH wins

Teleport = identity-aware access plane (Go, OSS+Cloud). SSO/OIDC + short-lived
certs, RBAC, per-session MFA (`tsh`), joint sessions + full recording,
`scp`/SFTP, K8s/DB/app proxy, browser UI. Reverse tunnel = no ingress, but
cluster ops (auth/proxy/nodes or Cloud) + agents everywhere.

Where Teleport wins (honest — best audit story in the matrix, now tied):
- Identity & audit (case 9: **100**, tied): Teleport still leads at fleet
  scale (short-lived certs, per-session MFA, joint sessions, K8s/DB/app
  proxy) — KS matches the rubric at homelab scale (SSO/RBAC/TOTP + audit +
  recording, see scoring deltas above).
- Collaboration (case 8: 80): joint sessions + recording; KS has none (0).
- Transport (cases 1/4: 85/87): reverse tunnel + cluster CA; KS matches on shape
  (90/80) with simpler E2E (`k` fragment, relay sees sizes only).

Where KS SSH wins vs Teleport (matrix deltas, same scoring):
- Single-box panel sweep (cases 5–7: 100/100/100 vs 40/10/10): HOME-jailed
  files + editor with caps, `/proc`+`ss` ports with PID kill, per-core/RAM/swap/
  filtered-`df` host graphs — Teleport doesn't try to be a homelab panel.
- Lightweight (case 10: 90 vs 30): one static binary + one Worker vs cluster
  ops; `curl … && ./ks-ssh` and done.
- Browser share-link (case 2: 93 vs 80): send-a-link phone triage with no client
  enrolment; Teleport needs `tsh`/enrolled identity.
- No licence/cloud dependency: KS is self-hosted OSS, unlimited boxes; Teleport
  depth costs cluster/Cloud commitment.
- Teleport's only outright win over KS is case 8 (collab). Closest
  gaps: NAT 90 vs 85, browser 93 vs 80, terminal 80 vs 80, E2E 80 vs 87 — all
  within 13 points; identity is now tied 100/100.

Verdict: pick Teleport if fleet/compliance at scale matters (cluster CA,
joint sessions, K8s/DB proxy, Cloud). Pick KS SSH if you want one binary for
shell + files + ports + host on a NAT box behind a share link, with
Teleport-level identity/audit at homelab scale instead of SSO infra.

Sources: `teleport.dev` (architecture, RBAC, recording, access plane),
`ekzhang/sshx` + `sshx.io` (canvas, E2E, Fly mesh, self-host notes),
this repo (`cli/backend/src/*.rs`, `cf/worker/*`, `cf/src/*`).

## E2E (sshx-style) + quick start

- `token` (5-char) routes; `k` (256-bit, `#k=...` fragment only) seals. `hello`
  negotiates `{e2e:"aes-gcm-v1"}`; sensitive payloads are `enc` (AES-256-GCM,
  96-bit nonce, AAD=token, seq from 0, strict increment). Relay learns room
  existence + sizes/timing only. UI bundle stays PLAINTEXT (public build).
  Legacy peers → `⚠️ relay-visible`; `--no-e2e` forces legacy; missing `k` →
  paste-full-link prompt (never fetched/stored).

```sh
curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh \
  && chmod +x ks-ssh && ./ks-ssh            # local UI at http://127.0.0.1:8080
./ks-ssh --user admin --pass '…'            # login gate + Users page (local only)
./ks-ssh --no-serve --token=ABCDE           # relay only → /v/ABCDE#k=<SECRET>
./ks-ssh --token=ABCDE                      # local UI + relay together
./ks-ssh --no-serve --token= --no-ui        # relay without UI push
```

Security: rotate guessable tokens via fresh `--token=`; `k` is the secret
(fragment only). `--user/--pass` protects the local UI only; the relay share
link stays bearer-open unless `--relay-auth` adds the one-time viewer PIN.
Prefer `--host 127.0.0.1`; Files jailed to `$HOME`, Ports kill PID-scoped (no PID
1/self). Don't bind `0.0.0.0` on untrusted nets without proxy auth.
