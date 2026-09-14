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
| Transport / relay | Outbound WSS agent, 9-char token (5-char legacy routes), single-file UI push (`ui-begin/chunk/end`), `/v/TOKEN`, full `rpc-*`/`shell-*` bridge to a loopback server with the same auth/RBAC, per-IP/scan rate-limit with 429 | Direct TCP, needs reachable sshd (`-R` DIY) | Outbound to global mesh, `sshx.io/s/…` link | Outbound SSH, 4 endpoints (SSH ro/rw + web ro/rw) | Outbound SSH, viewers use `ssh` | Needs ingress (port/proxy/VPN) | Needs ingress (reverse proxy) | Needs reachable sshd | Gateway needs ingress | Reverse tunnel (no ingress) | Outbound WG/QUIC (no ingress) | Outbound to MS edge |
| Crypto | AES-256-GCM `enc` (strict, session-bound AAD `TOKEN\|sess\|dir\|epoch`, TOFU fingerprint), HKDF `ks-ssh-e2e-v1`, `#k=` fragment only, `?k=` → 400, PIN inside `enc` | SSH (host-key TOFU) | Argon2+AES, fragment key, relay sees ciphertext | None (relay sees plaintext) | SSH | TLS via proxy only | TLS via proxy only | SSH to target | TLS to gateway (gw decrypts) | Short-lived certs + MFA | WireGuard / Zero Trust | Encrypted via MS (trusts vendor) |
| Terminal | Real PTY, multi-tab + vertical split, v2 seq/ack gap-free resume + ping RTT, predictive echo, CJK/IME + search + export, touch bar, bell/unread/latency (`shell.rs`, `Terminal.tsx`) | Reference PTY + `tmux`/`mosh` | Canvas panes, cursors, predictive echo, ephemeral | tmux preserved | Plain shared session | Solid PTY, CJK/IME | Login/SSH wrapper | Web SSH | Gateway SSH | Joint sessions | Plain SSH over net | Full terminal + editor |
| Files / ports / host | HOME-jailed files/editor (1/5/100MB caps) + `/proc` ports + kill + host metrics (`files.rs`, `ports.rs`, `host.rs`) | `scp`/`sftp` only | None | None | None | ZMODEM only | None | SFTP browser | SFTP browser | `scp`/SFTP, no health dash | SFTP/SCP | Full editor + port-fwd, no host dash |
| Auth / audit | Argon2id + RBAC (admin/operator/viewer) + TOTP/SSO + audit log + recording + opt relay PIN (`auth.rs`, `db.rs`, `shell.rs`, Audit/Recordings pages) | Keys/certs, no SSO/rec | Bearer link only | Bearer ro/rw links | SSH keys | Basic auth, `-R`, `-o` once | Login flags | Per-host SSH creds | LDAP/OIDC + recording | SSO/RBAC/MFA + recording (best) | IdP ACLs + recorder | MS/GitHub IdP + Live Share |
| Frontend | Embedded single-file bundle + CF SPA (Home/SSH/Session/Install/Settings, `App.tsx`); SSH `Visit` opens raw full-page CLI at `/v/TOKEN#k=…` (no CF chrome, `#k` preserved) | Terminal client | Web canvas + chat | Basic web + SSH | None (SSH client) | Web xterm | Web login | Web client | HTML5 RDP/VNC/SSH | Web + `tsh` | Admin console + Serve | `vscode.dev` |
| Routes / API | `/api/files\|ports\|host\|auth/*`, `/v1/shell`, `/v1/agent\|client`, `/v/TOKEN`, `/api/ui/*`, live relay status `/api/ssh/status?token=` + `/api/relay/<TOKEN>/status` (`?ui=status` → `agentOnline/hasUi/gated`), `/api/health` (now with `now`); `/api/ssh/*` stub removed (404 points to status API) | `ssh`/`scp`/`sftp` CLI | `sshx` → link; `… \| sh -s run` in CI | `tmate` → 4 endpoints | `upterm host -- bash` | `ttyd -p 7681 bash` | `wetty --ssh-host` / `gotty -w` | Host/user/key form | Connection mgmt API | Cluster API | Tailnet / Access policy | `code tunnel` |
| Build / install | One static binary (`cli/release/ks-ssh`) + `wrangler` Worker; `curl …/ks-ssh -o ks-ssh && ./ks-ssh` | OS preinstall | `curl -sSf https://sshx.io/get \| sh` (self-host discouraged) | Package install; `tmate-server` self-host | Binary / `go install` | Single C binary | npm / binary / Docker | Docker / demo site | Servlet + DB + proxy | Cluster ops / Cloud | Account + enrol nodes | MS account, not self-host |

## What KS SSH actually is (this repo, latest)

- **Local:** `ks-ssh --port 8080` on `127.0.0.1`/`0.0.0.0`; PTY over `/v1/shell`
  with reattach/scrollback/resize; tabs persist (`ks-ssh:terms*`).
- **Login gate:** `--user/--pass` → login page + `ks_ssh_auth` cookie (HttpOnly +
  Secure + SameSite=Lax, 12h absolute + 30min idle, `auth.rs:46-48,2713`) +
  Settings → Users (Argon2id, `0600`, main-password gate, `auth.rs:246`). Legacy
  unsalted SHA-256 `users.json` still logs in once, then upgrades to Argon2id
  (`auth.rs:786`). Roles admin/operator/viewer enforced per route
  (`auth.rs:67,107,194,2820`); TOTP 2FA + recovery codes (`auth.rs:372,2001`);
  optional OIDC SSO behind `--oidc-issuer/--oidc-client-id` (auto-provision as
  viewer, `auth.rs:1477,2425,2456`); 5 fails → 5min lockout (`auth.rs:57`).
  Enforced on the shared router, so login/RBAC/audit apply over the relay
  too (agent proxies to a loopback server with the same middleware,
  forwarding the viewer's cookie, `main.rs:293`, `relay.rs:560,719`).
- **Relay:** `--no-serve --token=` → outbound WSS + UI bundle push → `/v/TOKEN`
  (raw full-page CLI, no CF chrome) and the lobby `#/session/TOKEN` (CF chrome
  + iframe/`srcDoc`); SSH-list `Visit` links straight to `/v/TOKEN#k=…`
  preserving `#k` (`App.tsx`), with `Open raw`/fullscreen fallbacks doing the
  same. `--e2e-key=` reuses `k`, `--no-ui` skips push, `--no-e2e` =
  legacy plaintext (explicit escape hatch only: loud warning + `relay-downgrade`
  audit). Tokens: backend accepts exactly 5-or-9 alphanumerics
  (`relay.rs:78-81`, CLI error text says "5-9"); worker/CF route any 5–9
  (`worker/limit.ts` `TOKEN_RE`, `App.tsx` `TOKEN_EXACT_RE` is 5-or-9); 6–8
  chars therefore fail at the CLI (`bad token`) — use 5 or 9. Token scans hit per-IP + per-scan 429 budgets
  (`worker/limit.ts:15-27`, `worker/index.ts:47,72`). The pushed bundle is
  full-function: HTTP `/api/*` rides `rpc-*` and PTY rides
  `shell-open`/`shell-send` to a loopback server with
  the same router/auth/DB (`relay.rs:14,889,991`, `main.rs:293`), audited as
  `relay-rpc`/`relay-shell-open`/`relay-shell-close` (token only).
  Live status (no fake stubs): `GET /api/ssh/status?token=` and
  `GET /api/relay/<TOKEN>/status` report `agentOnline/hasUi/gated`
  (`worker/index.ts`, `room.ts` `?ui=status`), consumed by the SSH list, home
  dashboard, and installation health check (`App.tsx` `fetchRelayStatus`,
  configurable relay host/timeout in Settings); `relay-check.mjs` pins this +
  bans demo/fake/example stubs. Chunk uploads are 0-index safe
  (`room.ts` explicit `i` parse — `Number(0) || -1` used to drop chunk 0 and
  break every push as `incomplete`).
- **Panel:** Files + Ports + Host are served by `/api/*` — locally and, via
  the `rpc-*` bridge, over relay with the same login/RBAC.
- **Audit + recording:** append-only SQLite audit (`db.rs:335`, `GET /api/audit`,
  `GET /api/audit/export`, `auth.rs:2334,2364`, Audit page with filter +
  JSON/CSV export, `--audit-retain-days` default 90) and per-shell recording
  (timestamped in/out frames, `shell.rs:158`, `GET /api/terms/:id/recording`,
  replay player with play/pause/speed/scrub in Recordings + Terminal pages,
  `--record-max-mb` default 10, consent banner via `GET /api/record/status`).
- **Limits:** token addressing stays bearer-routed by default (routing only,
  `k` seals; 9-char fresh entropy + scan 429s); UI bundle is public build
  output by design (zero secrets proven by `ui_bundle_carries_zero_secrets`,
  `no-store`, `room.ts:96`); one Worker/DO relay, not a mesh; no collab
  (joint sessions). `--relay-auth` adds a one-time viewer PIN — sealed inside
  `enc` (`auth`, `relay.rs:1086`), 15min TTL + mint-invalidates-previous
  (`auth.rs:1561,1603`), constant-time verify (`auth.rs:1590`) — checked before
  any `data`/`rpc`/`shell` bridge (never in query/logs).

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
| 8 | Multi-user collaboration | 0 | 0 | **100** | 80 | 60 | 20 | 0 | 0 | 40 | 80 | 0 | 70 |
| 9 | Identity & audit (login/SSO/RBAC/recording) | **100** | 60 | 10 | 20 | 30 | 40 | 40 | 50 | 80 | **100** | 90 | 70 |
| 10 | Self-host simplicity / lightweight | 90 | **100** | 20 | 70 | 70 | **100** | 80 | 80 | 30 | 30 | 60 | 20 |

## Total Score

| Rank | Tool | Sum | Final /100 |
|---|---|---|---|
| **1** | **KS SSH** | **873 / 1,000** | **87** |
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

Latest fixes 2026-09-14 (relay UX + honesty, no score change): `room.ts`
chunk-0 parse fix (every UI push failed as `incomplete` before);
SSH `Visit` → raw full-page `/v/TOKEN#k=…` (same UI as `--port`, no CF
chrome, `#k` preserved; `Open raw`/fullscreen same); live relay status
(`agentOnline/hasUi/gated`) drives SSH list/home/installation health;
`/api/ssh/*` fake stub removed; `relay-check.mjs` bans demo/fake/example
stubs and pins the status API. Token lengths clarified above (CLI: exactly
5-or-9).

Case 9 re-scored 2026-09-14: KS 40 → **100** (Teleport parity at homelab
scale). Evidence per rubric item:
- **Strong auth:** Argon2id per-user salts (`auth.rs:246`), legacy SHA-256
  migrates on login (`auth.rs:786`); min-12 password policy + strength meter
  (`auth.rs:52,2745`, `Users.tsx`); 5 fails → 5min lockout per IP+user with
  audit (`auth.rs:57,672` + `lockout_after_five_fails` test); HttpOnly+Secure+
  SameSite=Lax cookie, 12h absolute + 30min sliding idle, rotated on privilege
  change (`auth.rs:46-48,2713`, `change_own_password`/`totp_verify` session
  rotation); self-service change-password (`auth.rs:1963`, `POST
  /api/auth/change-password`).
- **Least-privilege RBAC:** admin/operator/viewer (`auth.rs:67`), per-route
  matrix (`auth.rs:107,194`) enforced in middleware with 403 + audit row
  (`auth.rs:2820`); viewer = read files/host/ports + read-only shell attach
  (`shell.rs:855,1057`); operator = + shell write/upload/mkdir, no
  kill/delete/chmod/users; admin = all. Owner always admin, legacy users
  default operator. Role picker + lockout status + session revoke in `Users.tsx`
  (admin only); `GET /api/auth/me` reports role + 2FA (`auth.rs:1838`).
  Covered by the `rbac_matrix` unit test.
- **SSO/2FA option:** TOTP enroll/verify with otpauth URI + single-use recovery
  codes (`auth.rs:372,2001`, `totp_enroll_verify_roundtrip` test, Login 2FA
  field + Users self-service); OIDC authorization-code + PKCE behind
  `--oidc-issuer/--oidc-client-id` (`main.rs:73-88`, `auth.rs:1477,2425,2456`),
  auto-provision as viewer, `--oidc-allow-domain` whitelist, tokens never
  logged.
- **Full audit trail:** append-only SQLite `(ts, actor, ip, action, target,
  result)` (`db.rs:335,377`) for login/logout, user CRUD, file
  write/delete/chmod/zip/unzip (`files.rs:21`), ports kill (`ports.rs:18`),
  shell attach/detach, recording playback/delete (`shell.rs:724,786`), relay
  register/push/data (`relay.rs`, token only, never `k`/PIN). `GET
  /api/audit?limit&since` + `GET /api/audit/export?format=json|csv` (admin
  only, `auth.rs:2334,2364`); Audit page with filter + JSON/CSV export
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
  (90) and now leads on E2E (100) with strict session-bound sealing
  (`k` fragment, relay sees sizes only).

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
  gaps: NAT 90 vs 85, browser 93 vs 80 — both
  within 13 points; terminal leads 100 vs 80, identity is tied 100/100,
  and E2E now leads 100 vs 87.

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

Security: fresh `--token=` per session (9-char routing entropy + scan 429s);
`k` is the secret (fragment only — compare the viewer's fingerprint with the
CLI's on first connect). Token addressing is bearer-routed, but with
`--user/--pass` the relay is login-gated too (same loopback router/RBAC/audit);
add `--relay-auth` for the one-time viewer PIN on top. Prefer
`--host 127.0.0.1`; Files jailed to `$HOME`, Ports kill PID-scoped (no PID
1/self). Don't bind `0.0.0.0` on untrusted nets without proxy auth. No ECDH
yet: `k` is long-lived per link, so rotate links per session if that matters
to you.
