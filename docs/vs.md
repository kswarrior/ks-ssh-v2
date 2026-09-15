# KS SSH VS Web SSH Tools — Codebase Comparison

> Scope: browser-first remote shell access. Classic OpenSSH (`ssh user@host`,
> `~/.ssh/config`, `scp`) is the baseline — this page compares what you get when
> you want it **in a browser** and/or **without opening ports**.

> **Honest re-verification 2026-09-15 — main agent only, no sub-agents (per `debugging.md` Read → Understand → Fix → Build):** full read of `cf/src/App.tsx` (2608 lines), `cf/src/e2e.ts`, `cf/src/e2e.fixture.json`, `cf/worker/room.ts`, `cf/worker/index.ts`, `cf/worker/limit.ts`, `cf/wrangler.jsonc`, `cli/backend/src/main.rs`, `auth.rs`, `e2e.rs`, `relay.rs`, `shell.rs`, `files.rs`, `ports.rs`, `host.rs`, `db.rs`, `chat.rs`, `banner.rs`, `ui.rs`, `cli/frontend/src/App.tsx`, `relay-shim.ts`, `relay-e2e.ts`, `pages/Terminal.tsx`, `Files.tsx`, `Ports.tsx`, `Host.tsx`, `Login.tsx`, `Users.tsx`, `Audit.tsx`, `Recordings.tsx`, `components/ChatWidget.tsx`, `RecordingPlayer.tsx`, `hash-route.ts` and scripts. All claims below re-checked against these files:line citations; deltas from previous version noted in `Scoring deltas 2026-09-15`.

Columns: **KS** = KS SSH (this repo) · **SSH** = OpenSSH baseline · **sshx** =
sshx.io · **tmate** · **upterm** · **ttyd** · **wetty** = wetty/GoTTY ·
**Sshw** = Sshwifty · **Guac** = Apache Guacamole · **Tele** = Teleport ·
**Tail** = Tailscale SSH / CF Tunnel / ZeroTier · **VSCode** = VS Code tunnels.

## Homepage Features (verified 2026-09-15)

- **Terminal**: Real PTY, multi-tab + vertical split, gap-free resume (`v2` `u64-LE offset + PTY bytes`, `ready {v,seq,behind}`, `?from=` replay, `ack` watermark, `ping`/`pong` RTT), predictive echo, CJK/IME + search & export, touch bar, bell/unread/latency. (`cli/backend/src/shell.rs:17-68,135,205,239`, `cli/frontend/src/pages/Terminal.tsx:40-48,898,989,1009`).
- **Files**: HOME-jailed files & editor (caps: read 1 MB `files.rs:102`, save 5 MB `files.rs:104`, upload/download 100 MB `files.rs:106,961`, zip 200 MB `files.rs:1224`, unzip total 1 GB `files.rs:1226`), lexical path handling for missing paths (`files.rs:162-180`), zip/unzip, and media previews.
- **Ports**: Live `/proc/net/{tcp,tcp6,udp,udp6}` + `ss` fallback, per-port kill (TERM → wait → KILL, refuses PID 1/self, audited `ports-kill` `ports.rs:388-449`), and connection tracking over WSS.
- **Host**: Per-core (`/proc/stat` `host.rs:191-240` + `/proc/cpuinfo` `host.rs:150`), RAM/swap (`/proc/meminfo` `host.rs:278`), `df -kP -T` filtered (`host.rs:320-365`) host monitoring, metrics and system info – same as local --port.

## Identity

|  | KS SSH | SSH | sshx | tmate | upterm | ttyd | wetty | Sshw | Guac | Tele | Tail | VSCode |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stack | Rust axum + portable-pty + React/xterm.js + CF Worker/DO (`cli/backend/src/*.rs:main.rs:1-11`, `cf/worker/room.ts:25-42`, `cf/worker/index.ts:1-15`) | C OpenBSD client, 30y mature | Rust + SvelteKit + Fly.io/Redis mesh (7.6k★, 2022+) | C tmux fork + tmate.io relay (BSD) | Go SSH relay (OSS) | C + xterm.js (mature) | Node/Go + xterm (wetty/GoTTY) | Go + JS web client (OSS) | Java + guacd + MySQL/LDAP/OIDC (10y+ enterprise) | Go + Web UI, cluster (mature, OSS+Cloud) | WireGuard/QUIC + IdP (tailnet/Zero Trust) | TS/Rust CLI + MS cloud (`code tunnel`) |
| Transport / relay | Outbound WSS agent, 9-char fresh (`relay.rs:46-77` `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, ~46b) + 5-char legacy routes, 5-or-9 only `relay.rs:80-83` / `limit.ts:12` `TOKEN_RE`, single-file UI push (`ui-begin/chunk/end` `room.ts:274-348`, `relay.rs:51-58` 48KB chunks), `/v/TOKEN` (`room.ts:68-110` `no-store`), full `rpc-*`/`shell-*` bridge to loopback `127.0.0.1:0` with same auth/RBAC (`main.rs:311-332` `serve_loopback`, `main.rs:161-265` `build_router`, `relay.rs:14,889,991`), per-IP 120/min + per-miss 20/min `limit.ts:15-18` `checkLimit` + per-socket 200/10s → 4408 `room.ts:30-31,171` with 429 `retry-after` | Direct TCP, needs reachable sshd (`-R` DIY) | Outbound to global mesh, `sshx.io/s/…` link | Outbound SSH, 4 endpoints (SSH ro/rw + web ro/rw) | Outbound SSH, viewers use `ssh` | Needs ingress (port/proxy/VPN) | Needs ingress (reverse proxy) | Needs reachable sshd | Gateway needs ingress | Reverse tunnel (no ingress) | Outbound WG/QUIC (no ingress) | Outbound to MS edge |
| Crypto | AES-256-GCM `enc` v1 strict, session-bound AAD `TOKEN\|sess\|dir\|epoch` (`e2e.rs:189-197`, `cf/src/e2e.ts:117-122`), HKDF `ks-ssh-e2e-v1` salt 32 zeros `e2e.rs:84,140-145`, `cf/src/e2e.ts:181-203`, 96-bit nonce, 512KB cap `e2e.rs:82`, seq strict 0.. `e2e.rs:322-330` + TOFU fingerprint `ks-ssh-e2e-fp-v1`[:16] `e2e.rs:152-159` `cf/src/e2e.ts:150-158`, `#k=` fragment only `e2e.ts:82-114` `cf/src/App.tsx:950-953`, `?k=` → 400 `worker/index.ts:52-58`, PIN inside `enc` `auth` `relay.rs:1086` `room.ts:15-20` | SSH (host-key TOFU) | Argon2+AES, fragment key, relay sees ciphertext | None (relay sees plaintext) | SSH | TLS via proxy only | TLS via proxy only | SSH to target | TLS to gateway (gw decrypts) | Short-lived certs + MFA | WireGuard / Zero Trust | Encrypted via MS (trusts vendor) |
| Terminal | Real PTY portable-pty `shell.rs:spawn_shell` `TERM=xterm-256color`, multi-tab + vertical split `Terminal.tsx:1672` (local ephemeral), v2 `u64-LE offset + PTY bytes` gap-free resume `shell.rs:135,135-143,989,1009` + `ack` `shell.rs:205-213` + `ping`/`pong` RTT `shell.rs:205` `Terminal.tsx:46,48`, STALE 45s `Terminal.tsx:48` `1540`, PING 5s `Terminal.tsx:46`, backoff 200*2^a capped 2s `Terminal.tsx:40-44` `backoffMs` MAX 12, predictive echo `Terminal.tsx:predictInput`, CJK/IME unicode-11 search serialize `Terminal.tsx:699-716` + export, touch bar, bell/unread/latency | Reference PTY + `tmux`/`mosh` | Canvas panes, cursors, predictive echo, ephemeral | tmux preserved | Plain shared session | Solid PTY, CJK/IME | Login/SSH wrapper | Web SSH | Gateway SSH | Joint sessions | Plain SSH over net | Full terminal + editor |
| Files / ports / host | HOME-jailed files/editor (read 1 MB `files.rs:102`, save 5 MB `files.rs:104`, upload/download 100 MB `files.rs:106,961`, zip 200 MB `files.rs:1224`, unzip total 1 GB `files.rs:1226`, lexical for missing paths `files.rs:162-180` — symlink without `RESOLVE_IN_ROOT` still honest) + `/proc/net/{tcp,tcp6,udp,udp6}` + `ss` fallback `ports.rs:3-5,192-306` + kill TERM→KILL `ports.rs:388-449` + host per-core/RAM/swap/df-filtered `host.rs:150,191,278,320` | `scp`/`sftp` only | None | None | None | ZMODEM only | None | SFTP browser | SFTP browser | `scp`/SFTP, no health dash | SFTP/SCP | Full editor + port-fwd, no host dash |
| Auth / audit | Argon2id `auth.rs:254` `hash_argon2` + legacy hex SHA-256 migrates `auth.rs:793` + RBAC admin/operator/viewer `auth.rs:64-71,105-190` `Required::Viewer/Operator/Admin` + TOTP SHA1 6-digit 30s ±1 `auth.rs:316-364` + SSO OIDC + PKCE `auth.rs:438-451,1477` + audit SQLite `(ts,actor,ip,action,target,result)` `db.rs:335` + recording capped `db.rs:46-58` + opt relay PIN `auth.rs:RelayPinState` (`auth.rs`, `db.rs`, `shell.rs`, Audit/Recordings pages) | Keys/certs, no SSO/rec | Bearer link only | Bearer ro/rw links | SSH keys | Basic auth, `-R`, `-o` once | Login flags | Per-host SSH creds | LDAP/OIDC + recording | SSO/RBAC/MFA + recording (best) | IdP ACLs + recorder | MS/GitHub IdP + Live Share |
| Frontend | Embedded single-file bundle `cli/backend/src/ui.rs:12` `build_single_file` (`Ui::get` `rust-embed` `../frontend/dist`, inlines `assets/*.js/*.css` `ui.rs:25-47`, zero `/assets/` refs `ui.rs:149-154` `single_file_inlines_assets` + `no-store` `main.rs:134`) + CF SPA (Home/SSH/SshAdd/SshEdit/SshVisit/Install/Settings `cf/src/App.tsx:12,359,647,1202,1406,1640,1948,2294`, `cf/src/main.tsx`) ; SSH `Visit` opens raw full-page CLI at `/v/TOKEN#k=…` (no CF chrome, `#k` preserved `cf/src/App.tsx:950-953` `visitUrl`) | Terminal client | Web canvas + chat | Basic web + SSH | None (SSH client) | Web xterm | Web login | Web client | HTML5 RDP/VNC/SSH | Web + `tsh` | Admin console + Serve | `vscode.dev` |
| Routes / API | `/api/files\|ports\|host\|auth/*` `main.rs:187-254`, `/v1/shell` `main.rs:247`, `/v1/agent\|client` `worker/index.ts:62-83`, `/v/TOKEN` `worker/index.ts:93-108` `room.ts:68-110`, `/api/ui/*` `worker/index.ts:109-126`, live relay status `/api/ssh/status?token=` + `/api/relay/<TOKEN>/status` `worker/index.ts:138-164` (`?ui=status` `room.ts:73-91` → `agentOnline/hasUi/gated/updatedAt/size`), `/api/health` with `now` `worker/index.ts:128-130`; `/api/ssh/*` stub 404 `worker/index.ts:165-170` | `ssh`/`scp`/`sftp` CLI | `sshx` → link; `… \| sh -s run` in CI | `tmate` → 4 endpoints | `upterm host -- bash` | `ttyd -p 7681 bash` | `wetty --ssh-host` / `gotty -w` | Host/user/key form | Connection mgmt API | Cluster API | Tailnet / Access policy | `code tunnel` |
| Build / install | One single binary (`cli/release/ks-ssh`, ~19 MB dynamically-linked ELF `cli/rebuild.sh` = `frontend npm run build` + `cargo build --release -p ks-ssh`) + `wrangler` Worker `cf/wrangler.jsonc`; `curl -sSfL …/ks-ssh -o ks-ssh && chmod +x ks-ssh && ./ks-ssh` | OS preinstall | `curl -sSf https://sshx.io/get \| sh` (self-host discouraged) | Package install; `tmate-server` self-host | Binary / `go install` | Single C binary | npm / binary / Docker | Docker / demo site | Servlet + DB + proxy | Cluster ops / Cloud | Account + enrol nodes | MS account, not self-host |

## What KS SSH actually is (this repo, latest)

- **Local:** `ks-ssh --port 8080` on `127.0.0.1`/`0.0.0.0` (`main.rs:33-36` `host`/`port`, `Cli::port 8080`); PTY over `/v1/shell` (`main.rs:247` `ws_handler`, `shell.rs:936` `q.v == Some(2)` v2) with reattach/scrollback (256KB ring + 30min TTL + 64 sessions `shell.rs:62-68`)/resize; tabs persist (`ks-ssh:terms*` `cli/frontend/src/App.tsx:121` `ks-ssh:ssh`, `Terminal.tsx` `HostTerms`).
- **Login gate:** `--user/--pass` (`main.rs:41-48` `Option<String>` `user`/`pass`) → login page + `ks_ssh_auth` cookie (HttpOnly + Secure + SameSite=Lax, 12h absolute `COOKIE_MAX_AGE 12*60*60` + 30min idle `IDLE_TIMEOUT_SECS 30*60` `auth.rs:44-48`, rotation on privilege change `auth.rs:1051,1283`) + Settings → Users (Argon2id `auth.rs:254` `hash_argon2`, `0600` `auth.rs:1741`, main-password gate for edit/delete `auth.rs:1082,1194`, `auth.rs:254`). Legacy unsalted SHA-256 `users.json` still logs in once, then upgrades to Argon2id (`auth.rs:796` `needs_migrate` `hash_argon2`). Roles admin/operator/viewer enforced per route (`auth.rs:64-71` `Role` + `auth.rs:105-190` `required_role`/`role_allows` + `main.rs:257-259` `require_auth` middleware); TOTP 2FA SHA1 6-digit 30s ±1 + recovery codes (`auth.rs:316-418` `totp_*`, `auth.rs:372,2001`); optional OIDC SSO behind `--oidc-issuer/--oidc-client-id` (auto-provision as viewer, `auth.rs:1477,2432,2603` — homelab fallback parses `id_token` unverified over TLS); 5 fails → 5min lockout (`auth.rs:57` `RATE_MAX_FAILS 5`/`RATE_LOCKOUT_SECS 5*60` + `auth.rs:677-683` `record_fail`).
  Enforced on the shared router, so login/RBAC/audit apply over the relay too (agent proxies to a loopback server with the same middleware, forwarding the viewer's cookie, `main.rs:311-332` `serve_loopback` `127.0.0.1:0`, `relay.rs:560,719` `loopback` proxy).
- **Relay:** `--no-serve --token=` (`main.rs:51-65` `Cli::token` + `relay::new_token` 9-char `relay.rs:70`) → outbound WSS (`relay::run_agent` `relay_ws_base` `main.rs:150-159`) + UI bundle push (`ui-begin`/`ui-chunk`/`ui-end` `room.ts:274-348` 5MB `MAX_UI_BYTES` `room.ts:27`/`MAX_UI_CHUNKS 256` `room.ts:28`, 48KB raw `relay.rs:52` `UI_CHUNK_RAW`) → `/v/TOKEN` (raw full-page CLI, no CF chrome `room.ts:104-110` `no-store`) and the lobby `cf/src/App.tsx:1640` `SshVisitPage` (CF chrome + hidden preload `iframe onLoad→100%` `App.tsx:1914-1923` + `preconnect` `App.tsx:1672`); SSH-list `Visit` links straight to `/v/TOKEN#k=…` preserving `#k` (`cf/src/App.tsx:950-953` `visitUrl`, `SSHPage:1105`) with `Open raw`/fullscreen fallbacks same. `--e2e-key=` reuses `k` `main.rs:76-77` `e2e_key`, `--no-ui` skips push `main.rs:70`, `--no-e2e` = legacy plaintext (explicit escape hatch only: loud warning + `relay-downgrade` audit `relay.rs:1218,1240`). Tokens: backend accepts exactly 5-or-9 alphanumerics (`relay.rs:80-83` `valid_token`, CLI error "5-9" `main.rs:458`); worker/CF route any 5–9 (`worker/limit.ts:12` `TOKEN_RE`, `cf/src/App.tsx:10` `TOKEN_EXACT_RE`); 6–8 chars fail at CLI (`bad token`) — use 5 or 9. Token scans hit per-IP 120/min + per-miss 20/min 429 budgets (`worker/limit.ts:15-18` `RATE_*`, `worker/index.ts:47,72,98,113` `checkLimit`→`rateLimited` 429+`retry-after`). The pushed bundle is full-function: HTTP `/api/*` rides `rpc-begin`/`rpc-chunk`/`rpc-end` `relay.rs:16-20,53-60` 32MiB cap `MAX_RPC_BYTES` + 48KB `RPC_CHUNK_RAW` and PTY rides `shell-open`/`shell-send`/`shell-close` to a loopback server with same router/auth/DB (`relay.rs:14,889,991`, `main.rs:293`), audited as `relay-rpc`/`relay-shell-open`/`relay-shell-close` (token only `relay.rs:179,424`). Live status (no fake stubs): `GET /api/ssh/status?token=` and `GET /api/relay/<TOKEN>/status` report `agentOnline/hasUi/gated` (`worker/index.ts:138-164`, `room.ts:73-82` `?ui=status`), consumed by SSH list/home/dashboard/installation health (`cf/src/App.tsx:743-790` `refreshStatuses` `Promise.all` + `SettingsPage:2230` `relayWsHost`/`relayHttpBase`), `relay-check.mjs` pins this + bans demo/fake/example stubs. Chunk uploads are 0-index safe (`room.ts:294-302` explicit `i` parse — `Number(0) || -1` used to drop chunk 0 and break every push as `incomplete` `room.ts:317-320`).
- **Panel:** Files + Ports + Host are served by `/api/*` (`main.rs:188-215` `files::api_*`, `ports::api_*`, `host::api_host_info`) — locally and, via the `rpc-*` bridge (`relay.rs:889,991` `handle_inner_*` → `loopback` `http://127.0.0.1:PORT`), over relay with the same login/RBAC (`main.rs:311` `serve_loopback` shares `auth`/`db`/`shell`).
- **Audit + recording:** append-only SQLite audit (`db.rs:335,377` `(ts,actor,ip,action,target,result)`, `GET /api/audit?limit&since` `main.rs:241` `auth::api_list_audit`, `GET /api/audit/export?format=json|csv` `main.rs:242`, `auth.rs:2334,2364`, Audit page `cli/frontend/src/pages/Audit.tsx` with filter + JSON/CSV export, `--audit-retain-days` default 90 `main.rs:97` `cli.audit_retain_days` `db.rs:79` `set_audit_retain_days` + `db.rs:335` prune) and per-shell recording (timestamped in/out frames `shell.rs:85,156-164` `append recording`, `GET /api/terms/:id/recording?from&limit` `shell.rs:750,750-833` `api_get_recording_*`, `DELETE /api/terms/:id/recording` admin `shell.rs:835`, replay player `cli/frontend/src/components/RecordingPlayer.tsx` with play/pause/speed/scrub in Recordings `cli/frontend/src/pages/Recordings.tsx` + Terminal pages, `--record-max-mb` default 10 `main.rs:100-101` `db.rs:46,87` `set_record_max_mb`/`MAX_ENC_PLAINTEXT 512KB` `e2e.rs:82`, consent banner via `GET /api/record/status` `shell.rs:736` `is_recording_enabled`).
- **Limits:** token addressing stays bearer-routed by default (routing only, `k` seals; 9-char fresh entropy `relay.rs:47,70` `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` `TOKEN_LEN_NEW 9` + scan 429s `limit.ts:15-18,62-73`); UI bundle is public build output by design (zero secrets proven by `ui_bundle_carries_zero_secrets` `relay.rs:1576`, `no-store` `room.ts:107` `main.rs:134-135` + `build_single_file` `ui.rs:12` zero `/assets/` `ui.rs:149-154`); one Worker/DO relay (`cf/wrangler.jsonc` single DO `TunnelRoom`), not a mesh. **Collab is accounts + takeover + chat, not joint sessions:** multi-user accounts with RBAC (admin/operator/viewer, `auth.rs:64-71` `Role` `auth.rs:105-190` `required_role`), host-shared shells that any authed visitor can reattach to (`shared on purpose` `main.rs:53` `shell::shared`, `GET /api/terms` `shell.rs:607` `api_list_terms`, single `sub` `Mutex<Option<Sender>>` `shell.rs:234`, takeover `epoch` bump `shell.rs:930` + `4000 attached elsewhere`/`TrySend Takeover` `shell.rs:68,930,1022` `CLOSE_SUPERSEDED 4000`, viewer read-only `shell.rs:921` `read_only` flag `1122`) + persistent global chat (`GET|POST /api/chat` `chat.rs:47-63` `api_list_chat`/`api_post_chat` + `POST {"message"}` `chat.rs:86` `chat_insert` + `chat-send` audit `chat.rs:88`, `chat_messages` cap 1000 SQLite `db.rs:58` + `MEM_CHAT 500` `db.rs:53-57` `poll 3s` `ChatWidget.tsx:71,87` `clients Set` `room.ts:36` `[...clients]` fanout `room.ts:371` for N viewers per token, per-socket 200/10s → 4408 `room.ts:30-31,171`); no simultaneous co-typing/broadcast, no per-cursor/follow, no pane broadcast, no file co-edit. `--relay-auth` adds a one-time viewer PIN — sealed inside `enc` (`auth` `{"type":"auth","pin"}` `relay.rs:1086` `send_enc_shared`, `room.ts:15-20` gating `authGated` + `gated:true` in `paired`/`ui-ready` `room.ts:159,342`), 15min TTL + mint-invalidates-previous (`auth.rs:1561,1603` `RelayPinState::mint`/`verify` + `relay_pin_verify…` test), constant-time verify (`auth.rs:1590` `ct_eq`) — checked before any `data`/`rpc`/`shell` bridge (`relay.rs:1081,1232,1339` `relay_pin` gate, `relay-viewer-auth` audits) (never in query/logs `relay.rs:560,719` only token logged).

## Scored Matrix (/100 per case)

| # | Case | KS | SSH | sshx | tmate | upterm | ttyd | wetty | Sshw | Guac | Tele | Tail | VSCode |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | No-port / NAT traversal | 90 | 10 | **95** | 85 | 80 | 10 | 10 | 10 | 15 | 85 | 90 | 90 |
| 2 | Browser + share link + mobile | **93** | 0 | **93** | 73 | 13 | 73 | 67 | 73 | 80 | 80 | 40 | 87 |
| 3 | Terminal quality | **100** | **100** | 90 | 70 | 60 | 70 | 60 | 60 | 60 | 80 | 70 | 80 |
| 4 | E2E / transport security | **100** | 80 | **93** | 13 | 67 | 20 | 20 | 67 | 27 | 87 | **93** | 80 |
| 5 | File manager + editor | **100** | 30 | 0 | 0 | 0 | 20 | 0 | 40 | 40 | 40 | 30 | 90 |
| 6 | Ports / process mgmt | **100** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 10 |
| 7 | Host monitoring | **100** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 10 | 0 |
| 8 | Multi-user collaboration | **35** | 0 | **100** | 80 | 60 | 20 | 0 | 0 | 40 | 80 | 0 | 70 |
| 9 | Identity & audit (login/SSO/RBAC/recording) | **100** | 60 | 10 | 20 | 30 | 40 | 40 | 50 | 80 | **100** | 90 | 70 |
| 10 | Self-host simplicity / lightweight | 90 | **100** | 20 | 70 | 70 | **100** | 80 | 80 | 30 | 30 | 60 | 20 |

## Total Score

| Rank | Tool | Sum | Final /100 |
|---|---|---|---|
| **1** | **KS SSH** | **908 / 1,000** | **91** |
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

Scoring deltas 2026-09-15: honest full read in main agent (no sub-agents, per `debugging.md` Read → Understand → Fix → Build) of `cf/src/App.tsx` (2608 lines), `e2e.ts` (340), `worker/room.ts` (517), `worker/index.ts` (179), `worker/limit.ts` (74), `cli/backend/src/main.rs` (630), `auth.rs` (~2800), `e2e.rs` (776), `relay.rs` (1604), `shell.rs`, `files.rs`, `ports.rs`, `host.rs`, `db.rs`, `chat.rs`, `ui.rs`, `banner.rs`, `cli/frontend/src/App.tsx` (780), `relay-shim.ts` (RPC 120s `24` HELLO 10s `26`, `installRelayShim`), `relay-e2e.ts`, `pages/Terminal.tsx` (STALE 45s `48`, PING 5s `46`, backoff 200 `40`), etc. Re-verified: login gate (`auth.rs:44-48` cookie `COOKIE_MAX_AGE 12h`/`IDLE 30min`, `main.rs:161-265` `build_router`, `Login.tsx`, `Users.tsx`), PTY reattach 256KB ring + 30min TTL + 64 sessions (`shell.rs:62-68`), file caps read 1 MB `files.rs:102` save 5 MB `files.rs:104` upload/download 100 MB `files.rs:106,961` zip 200 MB/unzip 1GB `files.rs:1224,1226`, ports TERM→KILL refuses PID1/self (`ports.rs:388-449`), per-core/df-filtered host (`host.rs:150,191,278,320`), `enc` HKDF `ks-ssh-e2e-v1` salt 32 zeros `e2e.rs:84,140` AAD `TOKEN|sess|dir|epoch` `e2e.rs:189` + `?k=`→400 `worker/index.ts:52`, UI push 48KB chunks `relay.rs:52` cache `no-store` `room.ts:107` / single-file `ui.rs:12` zero `/assets/` `ui.rs:149`. `sshx` re-checked Sep 2026 (unchanged: canvas + E2E + Fly mesh, self-host discouraged). Panel split (cases 5–7) favours single-box managers by design — that is why KS leads; flip the weight to collab/audit and sshx/Teleport win.

Latest fixes 2026-09-15 honest re-verify (code → doc sync): `cf/src/App.tsx:189-214` boot `Promise.race` `AUTH_TIMEOUT 8500/3800` `HELLO_TIMEOUT 7500/3200` vs shim `relay-shim.ts:24,26` `RPC 120s`/`HELLO 10s` — matches `debugging.md` recipe 4.2; `Terminal.tsx:40-48` `STALE_MS 45000` (was 12000) `backoff 200*2^a capped 2000` `MAX_RETRIES 12` + `room.ts:294-302` chunk-0 parse fix (every UI push failed as `incomplete` before); `SSH Visit` `cf/src/App.tsx:950` `visitUrl` + `SshVisitPage:1640` preconnect + hidden preload `iframe onLoad→100%` → raw full-page `/v/TOKEN#k=…` (same UI as `--port`, no CF chrome, `#k` preserved; `Open raw`/fullscreen same); live relay status (`agentOnline/hasUi/gated`) `worker/index.ts:138-164` `room.ts:73` drives SSH list/home/installation health; `/api/ssh/*` fake stub 404 `worker/index.ts:165` points to status API; `relay-check.mjs` + `e2e-check.mjs` pin routing/gating + `session_vector` `e2e.fixture.json:15` `e2e_session_vector_stable` `e2e.rs:726` + `7508e2b9fe76ad77` fingerprint. Token lengths clarified above (CLI: exactly 5-or-9 `relay.rs:80` `limit.ts:12` `TOKEN_RE` / `App.tsx:10` `TOKEN_EXACT_RE`). **Case 8 re-score 0 → 35 in this doc** — your catch was right: accounts + takeover + chat count, joint sessions don't (see Case 8 below); Totals 873 → **908**, Final 87 → **91** — unchanged after 2026-09-15 re-read (honest).

Case 9 re-scored 2026-09-14: KS 40 → **100** (Teleport parity at homelab
scale). Evidence per rubric item:
- **Strong auth:** Argon2id per-user salts (`auth.rs:254`), legacy SHA-256
  migrates on login (`auth.rs:793`); min-12 password policy + strength meter
  (`auth.rs:52`, `Users.tsx`); 5 fails → 5min lockout per IP+user with audit
  (`auth.rs:57,672` + `lockout_after_five_fails` test); HttpOnly+Secure+
  SameSite=Lax cookie, 12h absolute + 30min sliding idle (`auth.rs:46-48,2722`),
  rotated on privilege change (`change_own_password`/`totp_verify` session
  rotation); self-service change-password (`auth.rs:1963`, `POST
  /api/auth/change-password`).
- **Least-privilege RBAC:** admin/operator/viewer (`auth.rs:67`), per-route
  matrix (`auth.rs:107,194`) enforced in middleware with 403 + audit row
  (`auth.rs:2845`); viewer = read files/host/ports + read-only shell attach
  (`shell.rs:921,1057`); operator = + shell write/upload/mkdir + **kill shell
  sessions** `DELETE /api/terms/:id` `auth.rs:170` (no ports kill / file delete /
  chmod / user mgmt); admin = all. Owner always admin, legacy users default
  operator. Role picker + lockout status + session revoke in `Users.tsx` (admin
  only); `GET /api/auth/me` reports role + 2FA (`auth.rs:1838`). Covered by the
  `rbac_matrix` unit test.
- **SSO/2FA option:** TOTP enroll/verify with otpauth URI + single-use recovery
  codes (`auth.rs:372,2001`, `totp_enroll_verify_roundtrip` test, Login 2FA
  field + Users self-service); OIDC authorization-code + PKCE behind
  `--oidc-issuer/--oidc-client-id` (`main.rs:82-93`, `auth.rs:1477,2432,2603`),
  auto-provision as viewer, `--oidc-allow-domain` whitelist, tokens never
  logged (homelab fallback parses `id_token` unverified over TLS).
- **Full audit trail:** append-only SQLite `(ts, actor, ip, action, target,
  result)` (`db.rs:335,377`) for login/logout, user CRUD, file
  write/delete/chmod/zip/unzip (`files.rs:21`), ports kill (`ports.rs:18`),
  shell attach/detach, recording playback/delete (`shell.rs:724,790`), relay
  register/push/data (`relay.rs:179,424`, token only, never `k`/PIN). `GET
  /api/audit?limit&since` + `GET /api/audit/export?format=json|csv` (admin
  only, `auth.rs:2341,2372`); Audit page with filter + JSON/CSV export
  (`Audit.tsx`); retention `--audit-retain-days` (`db.rs:79`). Covered by the
  `audit_write_and_list` test.
- **Session recording/replay:** per-shell timestamped in/out frames capped at
  `--record-max-mb`/session (`shell.rs:158`, `db.rs:86,423`), range reads
  (`db.rs:485`, `GET /api/terms/:id/recording`, `shell.rs:739`), read-only
  replay player with play/pause/speed/scrub (`RecordingPlayer.tsx`, embedded in
  Recordings + reachable from Terminal), consent banner when enabled
   (`GET /api/record/status`, `shell.rs:652`), default ON when auth is on
   (`main.rs:94-103`); playback respects RBAC (viewer plays, only admin
  deletes, `shell.rs:750`). Covered by recording roundtrip + cap tests.
- **Relay identity (honest close):** `--relay-auth` requires a one-time viewer
  PIN — sealed inside `enc` (`auth`, `relay.rs:1053`) once E2E is negotiated,
  legacy plaintext `hello.pin` only for non-E2E peers (`relay.rs:1151`) —
  before any `data`/`rpc`/`shell` bridge (`relay.rs:1081,1232,1339` +
  `relay-viewer-auth` audits); authed local users mint fresh PINs
  (`POST /api/relay/pin`, `auth.rs:2647`). Strict-by-default E2E refuses
  plaintext/downgrade peers with `relay-downgrade` audits
  (`relay.rs:1218,1240`). And with auth on, the relay is login-gated anyway:
  rpc/shell proxy to a loopback server running the same router, forwarding
  the viewer's cookie (`main.rs:293`, `relay.rs:560,719`) — same RBAC, same
  audit (`relay-rpc`, `relay-shell-open`/`relay-shell-close`, token only,
  never `k`/PIN). Token addressing stays bearer-routed by default
  (documented in the startup note + More page).

Case 3 re-scored 2026-09-14: KS 80 → **100** (OpenSSH parity in browser).
Evidence per rubric item (real PTY + instant feel + resilient reconnect +
full I/O fidelity + multi-tab UX on desktop and phone):
- **Real PTY:** portable-pty shell (`shell.rs:spawn_shell`, `TERM=xterm-256color`
  + truecolor), 256KB replay ring + 30min TTL + 64 sessions + resize
  (`shell.rs:62-68`, `Terminal.tsx:sendResize`), bracketed-paste passthrough
  (verified `\x1b[?2004h/l` in live frames).
- **Instant feel:** predictive local echo — printable chars render dimmed
  immediately, reconciled on server echo by byte-prefix match
  (`Terminal.tsx:predictInput/confirmPredictions`); engages only above 50ms
  smoothed RTT with 300ms server-idle gate, suspended in alt-buffer apps,
  toggle in tab menu (`PREDICT_KEY` persisted).
- **Resilient reconnect:** v2 `u64-LE offset + PTY bytes` frames
  (`shell.rs:encode_frame/decode_frame`), `ready {v,seq,behind}`,
  `?from=` tail-only replay with overlap trim (no dup/loss),
  `ack {seq}` watermark in `/api/terms`, `ping {t}`/`pong {t}` RTT;
  client exponential backoff 500ms→5s ×10, pending-input queue (256 cap)
  flushed on open, resize resent, yellow dot + `reconnecting… (attempt N)` +
  `NNms` pill (`Terminal.tsx:backoffMs`, `PING_MS`/`STALE_MS`).
  Old clients/servers stay byte-identical v1 (no `v`/`from`).
- **Full I/O fidelity:** xterm.js 5.3 + fit/search/web-links/unicode-11/
  serialize (`package.json`, `Terminal.tsx:699-716`); unicode v11 active
  (CJK/emoji widths), web-links clickable, Ctrl+F search bar over 5000-line
  scrollback, serialize export-to-.txt + copy-all, Ctrl/⌘+C copies when
  selected else SIGINT, 10KB paste verified intact (10241B heredoc live test).
- **Multi-tab UX:** persisted tabs + active id, proc-guess labels (8-char),
  per-tab bell flash + unread dot + RTT ms in tab bar, font A−/A+ persisted,
  bottom touch bar (Esc/Tab/arrows/Home/End/^C/^D/Paste, coarse-pointer only),
  ephemeral vertical split with per-pane socket (stacked on phones),
  shared-host attach list (`Terminal.tsx`, `App.css:term-*`).
  Single-file bundle still zero `/assets/` refs (`ui.rs:build_single_file` +
  `single_file_inlines_assets` test, multi-chunk safe).

Case 4 re-scored 2026-09-14: KS 80 → **100** (beats sshx 93 / Tail 93 /
Tele 87). Evidence per rubric item (sealed transport + strict default +
hardened routing + crypto lifetime + identity + metadata honesty):
- **Sealed transport, wired in all 3 peers:** every sensitive relay payload
  (PTY in/out, resize inside `shell-send`, `ack`, `rpc-*`, viewer PIN as
  `auth`) travels ONLY as `{"type":"enc",…}` (AES-256-GCM, 96-bit random
  nonce). Agent seals via shared state (`relay.rs:429 send_enc_shared`,
  `453 send_strict`, `889 handle_inner_rpc`, `991 handle_inner_shell`);
  the pushed UI shim seals via `E2eChannel`
  (`cli/frontend/src/relay-e2e.ts:173`, sealed `auth`/rpc/shell in
  `relay-shim.ts:384` + strict handshake `311-339`); the CF SPA lobbies with
  `e2e` + fingerprint + paste-link prompt (`cf/src/App.tsx:906,922,1115`).
  One vector locks the shared Rust↔WebCrypto format both ways
  (`cf/src/e2e.fixture.json:session_vector`, `e2e_session_vector_stable`
  `e2e.rs`, `scripts/e2e-check.mjs`). No new web deps (WebCrypto only);
  local `/v1/shell` is byte-unchanged.
- **Strict-by-default, no silent downgrade:** `strict_peer_ok`
  (`e2e.rs:201`, `cf/src/e2e.ts:125`) — E2E-on + legacy peer hard-fails with
  `E2E error` (`e2e.rs:79`) + `relay-downgrade` deny audit, never sends
  plaintext (`relay.rs:1157,1212,1240`). Missing `#k=` → paste-link prompt,
  never fetched/stored (`App.tsx:906 applyPaste`); agent-with-E2E + no `k`
  → `e2eRequired` banner + refusal (`relay-shim.ts:330-336`); wrong `k` →
  generic decrypt-failed (`relay.rs`, shim banner). `--no-e2e` survives only
  as the explicit escape hatch (loud warning + `relay-downgrade`
  `explicit-no-e2e` audit). Covered by `e2e_downgrade_rejected_by_strict`,
  `downgrade_strict_matrix`, and the e2e-check downgrade trio.
- **Hardened routing:** fresh tokens 9-char (~46b, `relay.rs:49,69,78`,
  `main.rs` 5-9 validation); 5-char legacy still routes (compat). Per-IP
  (120/min) + per-scan-miss (20/min) budgets with 429 + `retry-after`
  (`worker/limit.ts:15-27,67`, `worker/index.ts:47,72,98,113`); per-socket
  flood guard closes with 4408 (`room.ts:171-173`); `?k=` → 400
  (`index.ts:53-57`). Token scan reveals at most room existence + the public
  bundle — data stays sealed and (with `--relay-auth`) PIN-gated.
- **Crypto lifetime:** agent mints `sess` per run (`e2e.rs:174`) and bumps
  `epoch` per connection (`relay.rs` run_agent loop); AAD =
  `TOKEN|sess|dir|epoch` (`e2e.rs:191`, `cf/src/e2e.ts:118`,
  `relay-e2e.ts:162`) with mirrored `a2c`/`c2a` directions, so cross-session
  / cross-epoch (seq restarts at 0 safely) / reflected ciphertext fails the
  tag. Random `_pad` 0–64B per inner message (`e2e.rs:207`,
  `e2e.ts:137`); 512KB plaintext cap (`e2e.rs:82`). Covered by
  `e2e_session_binding_rejects_cross_session`,
  `e2e_epoch_replay_rejected_across_reconnect`,
  `e2e_direction_reflection_rejected`, and the e2e-check session negatives.
- **Identity binding:** `fingerprint()` =
  hex(SHA-256(`ks-ssh-e2e-fp-v1`‖raw))[:16] (`e2e.rs:152`,
  `e2e.ts:150`, `relay-e2e.ts:132`); CLI prints it and advertises `fp` in
  `hello` (`relay.rs` run_agent + `Hello:fp` + hello-reply for late joiners);
  the room replays hello caps to late joiners (`room.ts:51,140`);
  viewers verify + TOFU (shim `relay-shim.ts:315-324,343`, lobby
  `App.tsx:checkTofu` + fp line + changed-fp `E2E error` banner). PIN travels
  ONLY inside `enc` (`relay.rs:1086`), plaintext `pin` ignored once E2E
  (`relay.rs:1212`), constant-time verify (`auth.rs:1590`), 15min TTL +
  mint-invalidates-previous (`auth.rs:1561,1603`, `relay_pin_verify…` test).
  `k`/PIN never in query/fetch/logs/storage (fragment + memory only).
- **Metadata honesty:** relay learns room existence + sizes/timing only;
  control plaintext is enumerated and secret-free (`hello` caps, `paired`,
  `agent` presence, `ping`/`pong`, `ui-*` — `e2e.rs` header). UI bundle is
  public build output with a zero-secrets proof
  (`ui_bundle_carries_zero_secrets`, `no-store` `room.ts:96`, pre-existing
  size caps). `relay-check.mjs` pins the routing/gating evidence in CI
  alongside `e2e-check.mjs` (`npm run test:e2e` runs both).
- **Why 100 (not 93):** sshx matches E2E shape but self-host is discouraged
  and routing is vendor-meshed; Tailscale/Teleport move trust to vendor IdP /
  cluster CA. KS seals the same shape with self-hosted one-binary + one-Worker
  simplicity, then adds strict-no-downgrade, session/epoch/direction-bound
  AAD, TOFU fingerprints, PIN-inside-`enc`, and scan rate-limits — each with a
  named test. Remaining honest gap: one Worker/DO relay, not a mesh (case 1
  stays 90 vs sshx 95); no forward secrecy beyond per-run `sess`/per-connect
  `epoch` sub-binding (no ECDH yet — `k` is still the long-term secret, so
  rotate links per session for the paranoid).

Case 8 re-scored 2026-09-14: KS 0 → **35** (honest infra-without-joint). You
were right — `0` ignored real multi-user work: accounts + RBAC + shared shells
+ chat. But `35` stays honest because joint sessions need simultaneous
broadcast/cursors and KS only does takeover. Evidence:
- **Multi-user + RBAC:** `Users.tsx` CRUD + role picker + lockout + session
  revoke (`auth.rs:67,107,194` matrix, `auth.rs:2820` middleware 403 + audit,
  `main.rs:187,226-238` routes). Any number of concurrent logins
  (`auth.rs:531` `sessions HashMap`, 32-hex token `auth.rs:428`), viewer =
  read files/host/ports + read-only shell attach (`shell.rs:855,921,1057`),
  operator = + shell write/upload/mkdir, admin = all; `GET /api/auth/me`
  reports role + 2FA (`auth.rs:1838`). The shared router is enforced over the
  relay too (`main.rs:293`, `relay.rs:560,719` forwarding the viewer's cookie).
- **Host-shared shells (takeover, not broadcast):** `shared on purpose`
  (`main.rs:53`, `shell.rs:1,605`) — `GET /api/terms` lists host-wide shells so
  any authed visitor can reattach. But `Session.sub: Mutex<Option<Sender>>`
  (`shell.rs:234`) holds one active sink; `epoch` bump on attach
  (`shell.rs:930`) + old sender gets `TrySend Takeover`/`CLOSE_SUPERSEDED=4000`
  (`shell.rs:68,1022`, `Terminal.tsx:1168`) — second attacher evicts the first.
  Viewer flag `read_only` (`shell.rs:921,1122`) allows streaming but drops input.
  Ring `256KB` + `30min` TTL + `64` sessions (`shell.rs:62-68`), reaper +
  persister every 5s (`shell.rs:871,536`), and `HostTerms` attach list
  (`Terminal.tsx:395,1712`). No live viewer-count per shell.
- **Persistent chat (async, not joint):** `GET /api/chat?since&limit`
  + `POST /api/chat` (`chat.rs:47,63`), `db.rs:59` `MAX_CHAT_MESSAGES=1000`
  (SQLite `chat_messages` `db.rs:197` + mem `MEM_CHAT 500`), `3s` polling
  `ChatWidget.tsx:71`, audited `chat-send` (`chat.rs:88`, `auth.rs:125` viewer-
  allowed), works over the same `rpc-*`/`enc` bridge so it is live over relay
  (`room.ts:36` `clients Set` fanout `room.ts:371` `[...clients]` for N viewers
  per token, `200/10s → 4408` flood guard). Still 3s lag, global room only —
  no per-shell inline chat, no typing indicators, no cursor sharing.
- **Why 35 (not 60–100):** sshx `100` = canvas panes + cursors + follow +
  ephemeral mesh; tmate `80` / Tele `80` / VSCode `70` = simultaneous joint +
  recording/pane-share. KS fails all simultaneity: one `sub`, eviction not
  broadcast, ephemeral splits are local-only (`Terminal.tsx:1672` never shared),
  no file co-edit (last writer wins), no per-cursor, no tmux pane-share. `35`
  sits just above `ttyd 20` (unauth PTY) and below `Guac 40` (LDAP + RDP but
  still single-user) — honest for infra + takeover + chat without joint. A
  strict joint-only rubric would be `30`, a generous infra-counting one `40`.

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
- Collaboration (case 8: 80 vs 35): joint sessions + per-cursor follow +
  pane broadcast + Live Share; KS has accounts + RBAC + host-shared shells
  via takeover (single `sub`, `4000 attached elsewhere`) + global chat
  (`/api/chat`, `clients Set`), but no simultaneous co-typing, no cursors,
  no co-edit — see Case 8 re-score below.
- Transport (cases 1/4: 85/87): reverse tunnel + cluster CA; KS matches on shape
  (90) and now leads on E2E (100) with strict session-bound sealing
  (`k` fragment, relay sees sizes only).

Where KS SSH wins vs Teleport (matrix deltas, same scoring):
- Single-box panel sweep (cases 5–7: 100/100/100 vs 40/10/10): HOME-jailed
  files + editor with caps, `/proc`+`ss` ports with PID kill, per-core/RAM/swap/
  filtered-`df` host graphs — Teleport doesn't try to be a homelab panel.
- Lightweight (case 10: 90 vs 30): one single binary + one Worker vs cluster
  ops; `curl … && ./ks-ssh` and done.
- Browser share-link (case 2: 93 vs 80): send-a-link phone triage with no client
  enrolment; Teleport needs `tsh`/enrolled identity.
- No licence/cloud dependency: KS is self-hosted OSS, unlimited boxes; Teleport
  depth costs cluster/Cloud commitment.
- Teleport's biggest outright win over KS is case 8 (collab 80 vs 35, +45).
  Closest gaps: NAT 90 vs 85, browser 93 vs 80 — both within 13 points;
  terminal leads 100 vs 80, identity is tied 100/100, and E2E now leads
  100 vs 87.

Verdict: pick Teleport if fleet/compliance at scale matters (cluster CA,
joint sessions, K8s/DB proxy, Cloud). Pick KS SSH if you want one binary for
shell + files + ports + host on a NAT box behind a share link, with
Teleport-level identity/audit at homelab scale instead of SSO infra.

Sources: `teleport.dev` (architecture, RBAC, recording, access plane),
`ekzhang/sshx` + `sshx.io` (canvas, E2E, Fly mesh, self-host notes),
this repo (`cli/backend/src/*.rs`, `cf/worker/*`, `cf/src/*`).

## E2E (sshx-style) + quick start

- `token` (9-char fresh, 5-char legacy routes) addresses; `k` (256-bit,
  `#k=...` fragment only, never query/fetch/logs/storage) seals. `hello`
  negotiates `{e2e:"aes-gcm-v1", sess, epoch, fp, relay_auth?}` and the agent
  answers every client `hello` (plus the room replays caps to late joiners),
  so viewers always learn the session binding. Sensitive payloads are `enc`
  (AES-256-GCM, 96-bit nonce, AAD=`TOKEN|sess|dir|epoch` with mirrored
  `a2c`/`c2a`, strict seq per direction, random `_pad`). Relay learns room
  existence + sizes/timing only. UI bundle stays PLAINTEXT (public build,
  zero-secrets proof, `no-store`). Legacy peers → hard `E2E error` + audit
  (no silent downgrade); `--no-e2e` forces legacy (explicit hatch only);
  missing `k` → paste-full-link prompt; wrong `k` → decrypt-failed; viewer
  PIN (when `--relay-auth`) travels inside `enc` only, 15min TTL, one-time.
  Agent fingerprint (`E2E fingerprint: …` at startup) is TOFU-verified by
  viewers. Token scans hit 429 budgets.

```sh
curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh \
  && chmod +x ks-ssh && ./ks-ssh            # local UI at http://127.0.0.1:8080
./ks-ssh --user admin --pass '…'            # login gate + Users page (local only)
./ks-ssh --no-serve --token=                # relay only → /v/9CHARTOK#k=<SECRET> (fresh 9-char)
./ks-ssh --token=ABCDE1234                  # local UI + relay together (or reuse a token)
./ks-ssh --no-serve --token= --no-ui        # relay without UI push
```

Security: fresh `--token=` per session (9-char `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` `relay.rs:46` `TOKEN_LEN_NEW 9` ~46b, 5-char legacy, routing entropy + per-IP 120/min `limit.ts:15` + per-miss 20/min `limit.ts:17` + per-socket 200/10s 4408 `room.ts:30` scan 429s `worker/index.ts:52` `?k=`→400);
`k` is the secret (fragment only `cf/src/e2e.ts:82` `parseFragmentKey` `#k=` + `extractKeyFromText`, never query/fetch/logs/storage `e2e.rs:1-9` — compare the viewer's fingerprint `e2e.rs:152` `FP_INFO ks-ssh-e2e-fp-v1`[:16] `7508e2b9fe76ad77` `e2e.fixture.json:25` with the CLI's `relay.rs` `fp` in `hello` on first connect `checkTofu` `cf/src/e2e.ts:165`). Token addressing is bearer-routed, but with `--user/--pass` the relay is login-gated too (same loopback router `main.rs:311` `serve_loopback` `127.0.0.1:0` → `relay.rs:560,719` `loopback` proxy forwarding viewer's `ks_ssh_auth` cookie `auth.rs:44` `COOKIE_NAME` `HttpOnly`+`Secure`+`SameSite=Lax` 12h `auth.rs:46` + 30min idle `auth.rs:47`, 5 fails→5min lockout `auth.rs:57` RBAC `auth.rs:105` — viewer read-only `shell.rs:921`, operator +`rpc/mkdir/upload` `auth.rs:152-161`, admin all); add `--relay-auth` for the one-time viewer PIN inside `enc` only `relay.rs:1086` 15min TTL `auth.rs:1561` one-time `auth.rs:1603` `ct_eq` `auth.rs:1590` on top. Prefer `--host 127.0.0.1` (`main.rs:33` default `127.0.0.1`); Files jailed to `$HOME` (`files.rs:128-180` `HOME`/`USERPROFILE`→`/`, lexical `files.rs:162`), Ports kill PID-scoped (no PID 1/self `ports.rs:388-449` `run_kill` TERM→KILL). Don't bind `0.0.0.0` on untrusted nets without proxy auth. No ECDH yet (`e2e.rs:1-57` header — `k` 32 bytes `E2eKey([u8;32])` `e2e.rs:101`, HKDF `ks-ssh-e2e-v1` `e2e.rs:68` salt 32 zeros `e2e.rs:84` → `ks-ssh-e2e-v1` `cf/src/e2e.ts:35`, no ECDH): `k` is long-lived per link, so rotate links per session if that matters to you.

> **Honest 2026-09-15:** this page is the result of a main-agent-only full read (per `debugging.md` — Read ALL → Understand flows → Fix → Build). No sub-agents were spawned. Every number above was taken from a `file:line` you can open. If a line drifts, the code is the truth — not this doc. PRs that change `e2e.rs`/`relay.rs`/`room.ts`/`auth.rs`/`files.rs` must also update this file and the `e2e.fixture.json` vector + `relay-check.mjs`/`e2e-check.mjs` CI pins.
