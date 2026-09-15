# KS SSH v2 — DEBUGGING LOOP

> One debug loop for **both** sides: `cf/` (Cloudflare Worker + SPA) and `cli/` (Rust backend + embedded React frontend). Covers architecture, local run, logs, fast-load checklist, recipes, and **how to spawn sub-agents** for parallel debugging.

Use together with `loop.md` (single-task rules) and `map.md` (repo structure) if present. Order: `map.md` → `loop.md` → this file.

**Map rule:** read `map.md` FIRST for where everything lives (`cf/src/`, `cf/worker/`, `cli/backend/src/`, `cli/frontend/src/`). If a wave adds, moves, renames or deletes any main part/folder/flow, the MAIN agent must update `map.md` in the same wave so it never goes stale.

**Goal:** Find and fix every real bug through repeated multi-agent debugging. Never trust an agent's claim without real evidence.

---

## 0. MODEL COMPATIBILITY

- Primary model: Muse Spark (you are optimized for this file).
- Also usable as-is with: GLM, MiniMax, Ox, or any other coding model.
- If a model **cannot spawn real sub-agents**: run the §3 scopes **sequentially in waves** (one scope per pass) instead of in parallel. The loop, evidence bar, and exit conditions stay identical.
- If a model has a **small context window**: give it exactly ONE §3/§3.1 scope plus its file paths. Never paste the whole repo map.
- No model-specific syntax is required anywhere in this file. The §3.3 spawn prompt is plain text — copy/paste into any tool.

---

## 1. ARCHITECTURE

```
cf/                          cli/
├── src/App.tsx              ├── frontend/src/App.tsx (boot loader)
│   ├── SSHPage              │   ├── pages/Terminal.tsx (ShellSession)
│   ├── SshAddPage           │   ├── pages/Files.tsx
│   ├── SshEditPage          │   ├── relay-shim.ts (WSS tunnel)
│   ├── SshVisitPage         │   └── relay-e2e.ts (E2EChannel seq)
│   └── SettingsPage         ├── backend/src/relay.rs (agent session)
├── worker/                  │   ├── backend/src/e2e.rs (decrypt_next seq)
│   ├── index.ts (/v/,/api)  │   └── backend/src/shell.rs (sid/off replay)
│   ├── room.ts (DO)         └── backend/src/ui.rs (embed frontend/dist)
│   └── limit.ts             └── backend/src/db.rs, auth.rs, files.rs ...
└── wrangler.jsonc            release/ks-ssh (single binary)
```

**Flows**

| Flow | CF | CLI |
|------|----|-----|
| `Visit` | `SSHPage visitUrl -> SshVisitPage` or raw `https://…/v/TOKEN#k=` → `room.ts` `uiHtml` | `frontend boot` → `relay-shim installRelayShim()` → `WSS /v1/client?token=` → `agent hello` → `E2E` → `rpc / shell` |
| `Add/Edit` | `SshAddPage`/`SshEditPage` `#/ssh/add` `#/ssh/edit/:id` (real pages) | `Terminal` `v2 &from=off` `sid` persist `localStorage` |
| `Online` | `fetch /api/ssh/status` `room.ts:72 agentOnline` | `fetch /api/terms` `shell.rs` |

---

## 2. MAIN LOOP

```text
MAP → SPAWN AGENTS → INVESTIGATE/FIX → VERIFY
→ MAIN AUDIT → FIND NEW BUGS → REPEAT
```

Repeat until a complete audit finds **no actionable defect**.

Never stop because "it looks fixed".

---

## 3. BEFORE EACH WAVE

```bash
git status
git log --oneline -5
git diff --stat
```

1. Read `map.md` FIRST for the idea of the repo, then `loop.md` §0–§1 (paths, blast radius, duplicates). If the wave changed repo structure, update `map.md` before closing the wave.
2. Confirm which files are **real** (imported/built) vs duplicate/dead — never guess filenames, never edit `cli/frontend/dist/`, `cf/dist/`, `*.db*`, `cli/target/`, `cli/release/`, shipped migrations, or release artifacts. Check `rust-embed` in `cli/backend/src/ui.rs` and `vite build` outputs.
3. Define the wave scope: which §3/§3.1 agents run, their disjoint file sets, and the MAIN agent owner for shared contracts (`cf/worker/room.ts` UI chunk contract `48KB`, `cli/backend/src/e2e.rs` AAD `TOKEN|sess|dir|epoch`, `cli/backend/src/shell.rs` `v2/from` frame).

---

## 4. SPAWN SPECIALIZED SUB-AGENTS

Create **many independent agents based on the real repository structure**. Do not use only generic CF/CLI agents. Every major system, page, worker route, backend module, and connection surface should have its own specialist.

At minimum, inspect and create agents for:

```text
CORE / ARCHITECTURE
CF Worker (Hono-style routing, DO, KV/storage)
CF SPA (React router, pages, state)
CLI Backend (Rust Axum + WS)
CLI Frontend (React + xterm)
API / IPC (HTTP + WSS relay)
State Management (localStorage ks-ssh:ssh, session, shell offset)
Config / Environment (wrangler.jsonc, --relay, --e2e-key, --no-ui)
Persistence / Database (rusqlite ks-ssh.db, DO storage)
Authentication / Permissions (auth.rs, CF token, E2E)

CF SYSTEM (this repo is hybrid — map panel items to CF equivalents)
CF lifecycle (route enter/leave, hash routing)
CF ↔ Worker connection (DO room.ts heartbeat, WSS reconnect)
CF ↔ CLI connection (relay-shim tunnel client ↔ relay.rs agent, hello, reconnect)
CF frontend routing (cf/src/App.tsx — inspect EVERY page separately, no generic agent)
CF visibility / loading / error / empty states (SshVisitPage progress 12→92%→100%)
CF focus / blur / auth-guard redirects
Responsive behavior / viewport resize
Layout persistence (sidebar, settingsStore)
Startup / restart / recovery (wrangler dev, rebuild.sh, --no-serve)
Keyboard / mouse interactions
Hotkeys / global events (listeners, cleanup on unmount)

CLI SYSTEM
CLI lifecycle (boot loader App.tsx, auth check, hello, settle)
CLI ↔ Worker connection (relay-shim WSS /v1/client?token=, relay.rs /v1/agent)
CLI ↔ PTY connection (shell.rs sid/off replay, v2 frames)
CLI frontend routing (cli/frontend/src/App.tsx boot, pages/*)
CLI visibility / loading / error / empty states
Layout persistence (localStorage sid/off)

UI SYSTEM
Layout (cf/src/App.css, cli/frontend/src/App.css)
Components (ChatWidget, RecordingPlayer, Terminal xterm)
Navigation (hash routing, visitUrl)
Dialogs / Modals
Notifications / Toasts (console.warn KS relay)
Forms / Validation (SshAdd/Edit, Users)
Loading / Error / Empty states
Responsive behavior
Accessibility

E2E / RELAY SYSTEM (discovery-first: grep before spawning)
E2E key layer (cf/src/e2e.ts, cli/frontend/src/relay-e2e.ts, cli/backend/src/e2e.rs)
Relay shim (cli/frontend/src/relay-shim.ts)
Relay agent (cli/backend/src/relay.rs)
Room/Durable Object (cf/worker/room.ts)
WebSocket upgrade (/v1/agent, /v1/client, /v1/shell)
RPC bridge (rpc-begin/chunk/end, 48KB chunks, 5MB cap)
Retries / timeout / cancellation (HELLO 10s, RPC 120s, AUTH 8.5s)
Fallbacks (plaintext hello, preconnect)
Concurrency (shared E2E Mutex, ws forwarding)
Infinite-loop protection (MAX_MSG_PER_WINDOW 200/10s)

DATA / NETWORK
API contracts (/api/ssh/status, /api/auth/status, /api/terms, /v/TOKEN)
WebSocket/SSE (WSS tunnel, shell, files)
HTTP requests (fetch via shim vs direct)
Error responses (4408 flood, 426 upgrade, 400 ?k=)
Serialization (JSON envelope, E2E seal/open, frame u64 LE)
Caching (DO uiHtml, fetch no-store)
Persistence (settings, ssh entries, shell ring)
Database (rusqlite, upsert_with_seq, ring_base)
Migrations (none shipped — but check db.rs)
File/storage operations (files.rs, SFTP, DO storage)

RELIABILITY
Concurrency / races (E2E seq, ring_base/offset atomics)
Memory leaks (ring buffers, ws lists)
CPU / performance (vite 276k/788k chunks, 5MB UI)
Resource cleanup (ws close, beat interval, hint remove)
Timers / listeners (PING 5s, STALE 45s, backoff 200*2^a, saveOffset)
Background tasks (ensureUiLoaded, replayUi, push_ui_bundle)
Long-running operation (PTY, shell bridge)
Crash recovery (DO lastAgentHello, DB restored_seq)
Repeated open/close/restart testing (second open E2E, reload <2s vs 60s)

SECURITY
Secrets (token, E2E key fragment #k=, never ?k=)
Authentication (auth.rs argon2, session, --user/--pass)
Authorization (viewer_ok, relay_pin, authGated)
Input validation (validToken, pathToken, valid_session_id, MAX_UI_BYTES)
Command execution (shell.rs PTY, host.rs, ports.rs)
Filesystem boundaries (files.rs, mime_guess, sandbox)
Network security (rate limit ipHits/tokenMiss, CORS)
Sensitive logging (never log token/key, eprintln E2E decrypt failed only)
Production configuration (DEFAULT_RELAY_HOST, --relay, --relay-auth)

QUALITY / RELEASE
Tests (cf npm run test:e2e, e2e.fixture.json)
Failure injection (second tab, >10s idle reload, kill+reuse)
Static analysis (cf npx oxlint, cli cargo warnings)
Dependency audit (npm audit, cargo audit)
Build (cf tsc -b && vite build, cli bash rebuild.sh)
Packaging (cli/release/ks-ssh 19M, dist embed via UI::get)
Release scripts (rebuild.sh, wrangler deploy)
Startup/shutdown (main.rs --port, --no-serve, --db)
Platform compatibility (workers.dev, 127.0.0.1 vs 0.0.0.0)
Documentation/config consistency (wrangler.jsonc, package.json, Cargo.toml)

FRESH-EYES
Independent CF architecture reviewer
Independent CLI architecture reviewer
Independent E2E/relay reviewer
Independent security reviewer
Independent release reviewer
```

**IMPORTANT:** Create additional agents whenever the real repository contains another major subsystem, page, worker route, backend module, or feature not listed above. Do not force unrelated areas into one agent.

Each agent gets a narrow scope and must:

`INSPECT → REPRODUCE → FIND ROOT CAUSE → FIX → TEST → REPORT`

Agents may fix their own scope, but the MAIN AGENT must independently verify every important fix afterward.

### 4.1 REPO-SPECIFIC AGENTS (discovered from `cf/` + `cli/` — spawn these too)

Derived from real paths. Do not merge unrelated rows into one agent.

```text
CF SPA (cf/src/ — one agent per page, never merge)
- CF SSHPage (list, visitUrl, refreshStatuses) → cf/src/App.tsx:737-1105 SSHPage, refreshStatuses
- CF SshAddPage                  → cf/src/App.tsx:12xx SshAddPage #/ssh/add
- CF SshEditPage                 → cf/src/App.tsx:16xx SshEditPage #/ssh/edit/:id
- CF SshVisitPage (loader)       → cf/src/App.tsx:1630-1945 SshVisitPage parallel status+meta+WSS 7s+fetch /v/ preload
- CF SettingsPage                → cf/src/App.tsx:2300 SettingsPage
- CF E2E frontend                → cf/src/e2e.ts (HKDF aes-gcm-v1, fragment #k=, fp)
- CF Styles/App shell            → cf/src/App.css, cf/src/index.css, cf/src/main.tsx

CF WORKER (cf/worker/ — one agent per concern)
- Worker routing                 → cf/worker/index.ts (/v/, /v1/agent, /v1/client, /api/ssh/status, /api/ui/*, rate limits)
- Durable Object room            → cf/worker/room.ts (agentOnline, lastAgentHello, ensureUiLoaded, replayUi, uiHtml)
- Rate limiting                  → cf/worker/limit.ts
- Wrangler config                → cf/wrangler.jsonc, cf/worker-configuration.d.ts

CLI BACKEND MODULES (cli/backend/src/ — one agent per file, never merge)
- Auth/Session                   → cli/backend/src/auth.rs (argon2, session, lockout, TOTP)
- Relay agent                    → cli/backend/src/relay.rs (hello reset_seq, decrypt_next, shell bridge, ui push)
- E2E (Rust)                     → cli/backend/src/e2e.rs (E2e tx_seq/rx_next, encrypt_next/decrypt_next, reset_seq)
- Shell / PTY                    → cli/backend/src/shell.rs (sid/off replay, v2 frames, ring_base, encode_frame)
- Files / SFTP                   → cli/backend/src/files.rs
- Host info                      → cli/backend/src/host.rs
- Ports                          → cli/backend/src/ports.rs
- Chat                           → cli/backend/src/chat.rs
- Database                       → cli/backend/src/db.rs (upsert_with_seq, load_persisted, ring_base)
- UI embed                       → cli/backend/src/ui.rs (build_single_file, inline assets, marker ks-ssh-agent-ui)
- Banner / version               → cli/backend/src/banner.rs
- Main / CLI args                → cli/backend/src/main.rs (--host, --port, --token, --relay, --e2e-key, --no-ui, --db)

CLI FRONTEND (cli/frontend/src/ — one agent per area)
- Boot loader                    → cli/frontend/src/App.tsx (AUTH 8500/7500, Promise.race, bootProgress)
- Relay shim                     → cli/frontend/src/relay-shim.ts (WSS tunnel, RPC 120s, HELLO 10s, installRelayShim)
- E2E channel                    → cli/frontend/src/relay-e2e.ts (txSeq 0, rxNext 0, seal/open, seq check)
- Terminal / ShellSession        → cli/frontend/src/pages/Terminal.tsx (STALE 45s, PING 5s, backoff 200, MAX 12, sid/off)
- Files page                     → cli/frontend/src/pages/Files.tsx
- Host page                      → cli/frontend/src/pages/Host.tsx
- Ports page                     → cli/frontend/src/pages/Ports.tsx
- Users / Auth UI                → cli/frontend/src/pages/Users.tsx, cli/frontend/src/pages/Login.tsx
- Audit / Recordings / More      → cli/frontend/src/pages/Audit.tsx, Recordings.tsx, More.tsx
- Shared components              → cli/frontend/src/components/ChatWidget.tsx, RecordingPlayer.tsx

OPS / RELEASE
- Rebuild harness                → cli/rebuild.sh (frontend vite + cargo build --release → release/ks-ssh)
- CF build + deploy              → cf/package.json (tsc -b && vite build → dist/client + dist/ks_ssh_v2), wrangler deploy
- E2E conformance                → cf/scripts/e2e-check.mjs, cf/scripts/relay-check.mjs, cf/src/e2e.fixture.json
- Dist/embed verification        → cli/frontend/dist/, cf/dist/, cli/backend/src/ui.rs assets check

```

### 4.2 SPAWN RULES

```text
1. MAP FIRST: `ls cf/src/`, `ls cf/worker/`, `ls cli/backend/src/`, `ls cli/frontend/src/pages/` —
   spawn from what EXISTS, not from memory.
2. ONE SUBSYSTEM = ONE AGENT. Never merge e.g. relay.rs + shell.rs,
   or SSHPage + SshVisitPage, or auth.rs + e2e.rs, or Terminal + Files.
3. FILE OWNERSHIP: assign disjoint file sets per agent; shared contracts
   (E2E AAD TOKEN|sess|dir|epoch, DO ui chunk 48KB, shell v2 frame u64 LE,
   worker room UI contract) are READ-ONLY for all except the owning agent;
   MAIN AGENT resolves conflicts.
4. PAGES/ROUTES, not "modes": one agent per real page found in
   cf/src/App.tsx hashToPage + cli/frontend/src/pages/. No generic "panel modes" agent.
5. PROVIDERS: grep first (`rg -li "e2e|relay|DO|WSS" cli/backend/src/`).
   One agent per subsystem WITH code hits. No hits → ONE generic relay-layer agent.
   Never spawn an E2E agent from memory alone.
6. WAVE SIZE: max 4–6 parallel agents per wave (fewer for weak models).
   Extra scopes queue for the next wave. Same rule for sequential fallback.
7. STUCK AGENT: no report within the agreed timeout → MAIN marks its scope
   UNVERIFIED, re-queues it next wave with a narrower scope. Never block the wave.
```

Give each agent a narrow scope.

Agents may **inspect, reproduce, fix and test** their assigned problems.

Do not let multiple agents edit the same critical files simultaneously.

### 4.3 SUB-AGENT SPAWN PROMPT (copy/paste into ANY model/tool)

```text
You are a KS SSH debugging sub-agent. Scope: <ONE scope from §4/§4.1>.
Allowed files: <disjoint list>. Everything else is READ-ONLY.
Rules: loop.md §1–§3 (plan, minimal diff, follow existing patterns,
never edit shipped migrations / *.db* / cf/dist/ / cli/frontend/dist/ / cli/release/ / cli/target/,
fail closed on security, no swallowed errors, never log token/#k=).
Workflow: INSPECT → REPRODUCE → ROOT CAUSE → FIX → TEST.
Evidence bar: every claim needs command + exit code + output snippet.
Banned phrases: "probably fixed", "looks good", "should work".
Return ONLY the §7 report. Keep it under ~40 lines. List UNVERIFIED honestly.
Context: repo root <path>, base commit <sha>, wave <n>.
```

**How to spawn (Task tool) — CF + CLI examples:**

```ts
// CF flow — Visit loader
task({
  description: "CF Visit loader",
  prompt: "Explore cf/src/App.tsx SshVisitPage, cf/worker/room.ts, cf/worker/index.ts. Find why second Visit is 4-5s and returns loading. Return files:lines.",
  subagent_type: "explore"
})

// CLI flow — relay
task({
  description: "CLI relay",
  prompt: "Explore cli/frontend/src/relay-shim.ts, cli/backend/src/relay.rs, cli/frontend/src/pages/Terminal.tsx. Find why E2E seq 0 fails on 2nd tab. Return files:lines.",
  subagent_type: "explore"
})

// General multi-step fix
task({
  description: "Fix terminal reload",
  prompt: "Fix STALE_MS 12s → 45s and backoff 500→200 in cli/frontend/src/pages/Terminal.tsx, verify with tsc -b && vite build. Return what you changed.",
  subagent_type: "general"
})

// Boot 1-3 min vs --port 2-4s
task({
  description: "Trace Visit 1-3min",
  prompt: "Trace click Visit in cf/src/App.tsx SSHPage visitUrl -> SshVisitPage vs raw /v/ -> cli/frontend/src/App.tsx boot -> relay-shim.ts ensure() RPC 120s. Why does relay take 120s and port 50ms? Check cf/worker/room.ts ensureUiLoaded and cli/backend/src/ui.rs build_single_file. Return timeline.",
  subagent_type: "explore"
})

// Terminal reload 60s empty
task({
  description: "Terminal reload 60s",
  prompt: "Check cli/frontend/src/pages/Terminal.tsx ShellSession STALE_MS 12s, PING_MS 5s, backoffMs 500*2^a, lastMsgRef, v2Ref, saveOffset 10s throttle. Why does reload <2s fast but >10s slow even empty? Check shell.rs from handling.",
  subagent_type: "explore"
})
```

Sub-agents run in parallel — launch them in **one turn** with multiple `task` calls.

- `subagent_type: "explore"` → read-only, fast, thoroughness `quick|medium|very thorough`.
- `subagent_type: "general"` → can edit, run bash, verify.
- Always pass `description` (3-5 words), `prompt` (detailed task + what to return), `subagent_type`.
- Main agent **must not** duplicate work after delegating; wait for result.

### 4.4 FORBIDDEN FOR ALL AGENTS (any model)

```text
- No editing the same file as another agent in the same wave.
- No editing *.db* (ks-ssh.db), no touching cf/dist/ or cli/frontend/dist/ or cli/release/ by hand (rebuild via scripts).
- No editing cli/target/ or shipped release artifacts.
- No logging/printing/returning secrets: token, #k=, E2E key, password hashes, cookies.
- No adding ?k= to URLs — secret stays in fragment #k= (cf/worker/index.ts rejects ?k= with 400).
- No silent fallbacks, empty catch, or "temporary" workarounds — fail closed on auth/E2E.
- No commits/pushes unless the MAIN agent explicitly orders it.
```

---

## 5. EACH AGENT MUST

```text
FIND → REPRODUCE → ROOT CAUSE → FIX → TEST
```

Check for:

- crashes/errors
- race conditions/deadlocks (E2E seq, ring_base/offset)
- memory/resource leaks (ring, WSS lists, intervals)
- broken state/lifecycle (boot, WSS hello, PTY sid/off)
- bad API contracts (fetch via shim vs direct, /api shapes)
- CF/CLI relay behavior (WSS upgrade, RPC timeout, hello timeout)
- E2E failures/timeouts/retries (decrypt_next, tamper, replay)
- persistence bugs (DO storage, DB restored_seq, localStorage)
- security issues (token, #k=, auth bypass, IDOR, injection)
- performance problems (120s RPC blocking boot, STALE 12s, backoff 500)
- duplicate/dead/conflicting code (check App.tsx vs App.tsx, real vs dead)
- build/release failures (tsc, vite, cargo, embed)

### 5.1 EVIDENCE BAR (same for every model)

A bug counts as FIXED only with ALL of:

1. Reproducer BEFORE the fix (failing command/log/test + exit code).
2. Same reproducer AFTER the fix (passing + exit code).
3. Regression check on neighbors (`loop.md` CHECKLIST V, at least V1–V4).
4. Pasted output snippet or log tail — never a paraphrase.

Banned (treated as NOT DONE):

```text
"probably fixed"
"looks good"
"should work"
```

Weaker models: paste FULL command output, not summaries. If you cannot run a command, say so in UNVERIFIED — do not fake it.

### 5.2 KS SSH FAST-LOAD CHECKLIST (verify every wave)

Check these before closing a wave — all must hold:

- [ ] `cli/frontend/src/App.tsx` boot `Promise.race` timeout `8500/7500` (relay) / `3800/3200` (direct) not `120000` — `AUTH_TIMEOUT`/`HELLO_TIMEOUT` race prevents `RPC 120s` stall
- [ ] `cli/frontend/src/relay-shim.ts:24` `RPC_TIMEOUT_MS 120_000` kept for bulk RPC, `HELLO_TIMEOUT_MS 10_000` for handshake — not merged
- [ ] `cli/backend/src/e2e.rs:266` `reset_seq()` exists + `cli/backend/src/relay.rs:1206` hello resets `shared.lock().await → reset_seq()` + `viewer_ok=false`
- [ ] `cli/frontend/src/pages/Terminal.tsx:40-48` `STALE_MS 45000` (was 12000), `backoffMs 200*2^a capped 2000`, `MAX_RETRIES 12`, `PING_MS 5000`
- [ ] `cli/frontend/src/pages/Terminal.tsx:1528` beat gated `if(v2Ref.current && lastMsgRef.current>0 && now-lastMsg>STALE_MS) close`, `cli/frontend/src/pages/Terminal.tsx:1582` flush on `visibilitychange/pagehide/beforeunload` + `saveOffset()` throttle 10s
- [ ] `cli/backend/src/shell.rs:937` `v2` clamped `from>head→head`, `behind` flag, `encode_frame` v2 frames, `acked fetch_max`
- [ ] `cf/src/App.tsx:743` `refreshStatuses` `Promise.all` not sequential + `cf/src/App.tsx:1671` `preconnect` hint to `wsHost`
- [ ] `cf/src/App.tsx:949` `visitUrl` raw `/v/TOKEN#k=` (never `?k=`) + `cf/worker/index.ts:52` rejects `?k=` with 400
- [ ] `cf/src/App.tsx:1640` `SshVisitPage` parallel `status + meta + WSS 7s + fetch /v/` preload, progress `12→92%` + hidden preload iframe `onLoad→100%`
- [ ] `cf/worker/room.ts:422` `ensureUiLoaded` `Promise.all(storage.get uiHtml, uiUpdatedAt)` + `replayUi` chunk `48KB`
- [ ] `cli/backend/src/ui.rs:12` `build_single_file()` inline `script`/`link` + favicon data URI, `cli/release/ks-ssh` rebuilt after `frontend/dist` change (`bash rebuild.sh`)
- [ ] `cf/dist` built (`npm run build`) and `wrangler deploy` if testing live `workers.dev`

Quick grep:

```bash
grep -n "AUTH_TIMEOUT\|HELLO_TIMEOUT" cli/frontend/src/App.tsx
grep -n "reset_seq" cli/backend/src/e2e.rs cli/backend/src/relay.rs
grep -n "STALE_MS\|backoffMs\|MAX_RETRIES" cli/frontend/src/pages/Terminal.tsx
grep -n "refreshStatuses\|preconnect\|visitUrl" cf/src/App.tsx
```

### 5.3 LOGS & WHERE TO LOOK

| Symptom | Check | File:line |
|---------|-------|-----------|
| `1-3 min` raw open (port 2-4s) | `RPC_TIMEOUT 120s` `HELLO 10s` blocking boot `fetch /api/auth/status` via shim | `cli/frontend/src/App.tsx:186` `cli/frontend/src/relay-shim.ts:24` |
| `second open 4-5s + loading` | `E2E seq` desync `new E2eChannel txSeq 0` vs agent `rx_next N+1` → `decrypt_next seq!=rx_next` → `E2E decrypt failed` → `120s` pending | `cli/backend/src/e2e.rs:266` `cli/backend/src/relay.rs:1108` `cli/frontend/src/relay-e2e.ts:173` |
| `terminal reload 60s` empty | `STALE_MS 12s` kills idle empty (`v2==false` no ping) → `backoff 500*2^a 36.5s` | `cli/frontend/src/pages/Terminal.tsx:40` `1528` |
| `SSH offline stale` | `online` persisted `localStorage ks-ssh:ssh` not rechecked | `cf/src/App.tsx:2316` `743 refreshStatuses` |
| `Visit shows Starting…` | `auth===null` boot gate only `Checking login…` static | `cli/frontend/src/App.tsx:438` |
| `Visit shows CF loader not raw` | `SSHPage href="#/ssh/visit/:id"` vs `visitUrl /v/#k=` | `cf/src/App.tsx:1105` |

**Enable logs**

```bash
# CLI agent
RUST_LOG=debug ./cli/release/ks-ssh --token=TEST --port 8080
# CF Worker
wrangler tail
# Browser
localStorage.debug = 'ks-ssh:*'
# Frontend console
console.warn('KS relay: …') // shim fingerprint mismatch, E2E decrypt failed
```

### 5.4 DEBUGGING RECIPES

#### CF SSH online stale after refresh

```ts
// cf/src/App.tsx:2316 initial state forced offline
.filter(...).map(x=>({...x, online:false}))
// SSHPage:743 refreshStatuses parallel fetch /api/ssh/status?token= per entry, Map→onChange, openWatchSocket for newlyOnline
// Sockets: openWatchSocket per online entry, onclose→online:false, attemptConnect timeout 8000
```

Debug: `curl -s https://…/v1/client?token=TOKEN` (should 426), `curl -s https://…/api/ssh/status?token=TOKEN` → `{"agentOnline":true}`.

#### Visit raw 1-3 min

```bash
# Before fix: boot awaited fetch via shim with 120s RPC
# After: Promise.race([fetch, timeout 8500/7500]) + isRelay check
grep -n "AUTH_TIMEOUT\|HELLO_TIMEOUT" cli/frontend/src/App.tsx
```

Debug: open `https://…/v/TOKEN#k=` → F12 Network → `auth/status` 3.8s race vs `120s` pending.

#### Second open E2E fail

```bash
grep -n "reset_seq" cli/backend/src/e2e.rs cli/backend/src/relay.rs
# Must be: on hello from new client, shared.lock().await → reset_seq() + viewer_ok=false
```

Debug: second tab console → `E2E decrypt failed` → check `shared.reset_seq()` added `relay.rs:1206`.

#### Empty terminal reload 60s

```ts
// Terminal.tsx:40 STALE_MS 45000 (was 12000), backoff 200*2^a capped 2000, MAX_RETRIES 12
// beat 1528 gated if(v2Ref.current && lastMsg>STALE) close
// flush 1582 visibilitychange/pagehide/beforeunload saveOffset()
```

Debug: open empty terminal → wait 15s → reload → Network `v1/shell?v=2&from=` should be `200` not `1011` close.

#### CF Visit loader (optional)

`cf/src/App.tsx:1640 SshVisitPage` parallel `status + meta` + `WSS 7s` + `fetch /v/` preload, `preconnect link` to `wsHost`, `progress 12→92%` + hidden preload `iframe onLoad→100%` → `visit-frame`. Primary `Visit` now raw `visitUrl` `cf/src/App.tsx:949`.

---

## 6. LOCAL RUN

```bash
# CF SPA + Worker (local)
cd cf
npm install
npm run dev          # vite 5173
npm run build        # tsc -b && vite build -> dist/client + dist/ks_ssh_v2
wrangler dev         # local DO

# CLI (Rust + embedded frontend)
cd cli
bash rebuild.sh      # frontend npm run build + cargo build --release -p ks-ssh -> release/ks-ssh
./release/ks-ssh --port 8080                    # local only
./release/ks-ssh --token=ABCDE1234 --port 8080  # relay + local
./release/ks-ssh --no-serve --token=            # relay only, prints https://…/v/TOKEN#k=
```

**Env**

```bash
CF relay host: ks-ssh-v2.kswarriorpro.workers.dev (DEFAULT_RELAY_HOST='')
CLI --relay https://…   --e2e-key '<k>'   --no-ui   --relay-auth
```

---

## 7. AGENT REPORT (strict schema — one block per bug)

```text
SCOPE:      <§4 scope + wave number>
SEVERITY:   <P0 crash/data-loss/sec-hole | P1 major broken flow | P2 minor/edge-case>
BUG:        <one line, observable symptom>
ROOT CAUSE: <one line, code-level cause + file:line>
EVIDENCE:   <repro command + exit code BEFORE → AFTER>
FIX:        <what changed + why it addresses the cause>
FILES:      <paths touched>
TESTS:      <commands run + exit codes>
UNVERIFIED: <anything not proven — never leave blank, write "none" if empty>
```

Severity guide: P0 = crash, data loss, auth bypass, startup failure. P1 = major feature broken, contract mismatch, migration failure. P2 = cosmetic, rare edge case, docs drift. P2s batch into one wave; P0/P1 block the exit condition.

---

## 8. MAIN AGENT AUDIT

After all agents finish, the MAIN AGENT must independently (re-read the files — never trust agent summaries):

```text
review every change
→ inspect git diff + git diff --stat
→ trace affected flows (boot → relay-shim → relay.rs → shell.rs both directions)
→ check frontend ↔ backend ↔ worker ↔ DB/API contracts
→ check agent fixes for regressions (§9 second-order check)
→ run build/tests/typecheck/lint:
    cf:         npm run build && npx oxlint
    cli frontend: tsc -b && vite build (via rebuild.sh)
    cli backend: cargo build --release -p ks-ssh (and cargo test if present)
    e2e:        npm run test:e2e (cf/scripts/e2e-check.mjs + relay-check.mjs)
→ run real runtime checks:
    ./cli/release/ks-ssh --port 18080 & curl -s http://127.0.0.1:18080/api/hello
    ./cli/release/ks-ssh --token=TEST --port 18080 & # open https://…/v/TEST#k=... twice, second should be 2s not 5s, terminal reload after 20s should be <3s
→ check E2E/relay behavior (retries, timeouts, seq, fallbacks)
→ perform security + resource review (injection, authz, secrets, IDOR, open redirects, mass assignment, ?k= vs #k=, token leaks)
```

Assume every sub-agent can be wrong. A wave with zero independent `git diff` inspection by MAIN = failed wave. Record per-agent verdict: ACCEPT / REWORK (with reason) / REVERT.

---

## 9. SECOND-ORDER CHECK

After fixing bugs, actively search for bugs **created by the fixes**:

```text
new race? (E2E reset_seq vs concurrent decrypt_next)
new duplicate request? (refreshStatuses double fetch, boot double hello)
new state bug? (online:false forced, viewer_ok, v2Ref)
broken caller? (visitUrl raw vs hash route, shim fetch vs direct)
bad cancellation? (AbortController, ws close, ctrl.abort)
startup/restart failure? (DB restored_seq, DO lastAgentHello, rebuild.sh)
E2E failure handling? (decrypt_next 120s pending, fingerprint mismatch)
resource leak? (beat interval, ws list, ring buffer)
API mismatch? (frontend /api/ssh/status vs worker /api/ssh/status?token=)
```

---

## 10. FAILURE LOOP

Any failure:

```text
FAIL
 ↓
reproduce
 ↓
root cause
 ↓
fix
 ↓
FULL VERIFY
 ↓
START NEW DEBUG WAVE
```

Do not only rerun the failed test.

---

## 11. HARD PROBLEMS

If the same bug survives repeated attempts:

```text
STOP PATCHING
→ create fresh investigation agent
→ re-read actual code
→ reproduce from scratch
→ find the wrong assumption
→ redesign the fix
→ verify again
```

---

## 12. EXIT CONDITION

Stop only when ALL hold (each with command + exit code on record):

```text
No known P0/P1 bugs (P2 list attached or "none")
Build PASS (cf tsc -b && vite build + cli cargo build --release + frontend vite)
Tests PASS (cf npm run test:e2e + cli cargo test if present + tsc --noEmit)
Runtime PASS (./release/ks-ssh --port 18080 curl hello + relay second-open 2s + terminal reload <3s, log tail read)
Critical flows PASS (Visit raw, SshAdd/Edit, Terminal sid/off, Files, Online status, E2E roundtrip)
CF/CLI contracts PASS (V3 grep-proven: visitUrl #k= no ?k=, E2E AAD, DO 48KB chunk, shell v2 frame)
E2E/Relay PASS (E2E decrypt 120s gone, hello 10s, RPC 120s not blocking boot)
Security PASS (auth, token/#k=, secrets, IDOR, ?k= rejected, no token logs)
Fresh-eyes audit PASS (= independent agent re-ran §8 on final diff, found no P0/P1)
Final diff reviewed by MAIN (`git diff` + `--stat` read, verdicts recorded)
```

Otherwise start another wave.

**There is no fixed number of waves.**

```text
MAIN
 ↓
AGENTS
 ↓
FIX
 ↓
VERIFY
 ↓
MAIN AUDIT
 ↓
NEW BUG?
 ├─ YES → NEW WAVE
 └─ NO  → FINAL VERIFY
```

Final status must be:

`NO KNOWN ACTIONABLE DEFECTS FOUND IN VERIFIED SCOPE`

Never claim `BUG FREE`.

---

## 13. VERIFY (commands)

```bash
# CF
cd cf && npm run build && npx oxlint

# CLI frontend + embed
cd cli && bash rebuild.sh
# -> frontend/dist/index.html 1k, assets/index-*.js 788k, release/ks-ssh 19MB

# E2E conformance
cd cf && npm run test:e2e
# -> e2e-check.mjs + relay-check.mjs (roundtrip, tamper, replay, cross-room)

# Smoke
./cli/release/ks-ssh --port 18080 & curl -s http://127.0.0.1:18080/api/hello | head
./cli/release/ks-ssh --token=TEST --port 18080 &
# then open https://…/v/TEST#k=... twice, second should be 2s not 5s, terminal reload after 20s should be <3s
```

---

## 14. FILES TO WATCH

```text
cf/src/App.tsx:12,130,637,739,949,1105,1630,2300
cf/src/e2e.ts
cf/worker/index.ts:22,52,62,93
cf/worker/room.ts:46,113,174,398,422
cf/worker/limit.ts
cli/frontend/src/App.tsx:186,215,243,438
cli/frontend/src/relay-shim.ts:24,240,673
cli/frontend/src/relay-e2e.ts:173
cli/frontend/src/pages/Terminal.tsx:40,1528,1582
cli/backend/src/auth.rs
cli/backend/src/e2e.rs:266,299,322
cli/backend/src/relay.rs:298,1108,1191,1206
cli/backend/src/shell.rs:95,937,977
cli/backend/src/ui.rs:12
cli/backend/src/db.rs:243,538,593
```

---

## 15. SUB-AGENT DEBUGGING PLAYBOOK (copy-paste template)

**Template to copy-paste**

```md
Task: Debug <symptom>
Spawn:
- explore `cf/...` → files:lines for <CF part>
- explore `cli/...` → files:lines for <CLI part>
- general fix → edit + `tsc -b && vite build` + `bash rebuild.sh`
```

**Current fixes as examples**

| Fix | Sub-agents spawned | What they returned |
|-----|-------------------|-------------------|
| `online stale` | 1×explore `cf/src/App.tsx` | `online` persisted, no recheck |
| `Visit 1-3 min` | 2×explore `cf/worker/room.ts` + `cli/frontend/src/relay-shim.ts` | `RPC 120s` vs `port 50ms` |
| `2nd open 4-5s` | 1×explore `E2E seq` | `reset_seq` missing |
| `terminal 60s` | 1×explore `Terminal.tsx` | `STALE 12s + backoff 36.5s` |

**How to spawn now (for next bug)**

```bash
# In this chat, the assistant will run:
task({ description: "CF flow", prompt: "Explore cf/src/App.tsx ...", subagent_type: "explore" })
task({ description: "CLI flow", prompt: "Explore cli/frontend/src/...", subagent_type: "explore" })
# Then a general agent to fix both:
task({ description: "Fix both flows", prompt: "Apply fixes to cf/src/App.tsx and cli/frontend/src/App.tsx and verify builds", subagent_type: "general" })
```

---

*Generated for Muse Spark / opencode — use with `Task` sub-agents for every CF+CLI debug. Adapted from `kswarrior/ks-panel-extreme/loop-subagent-debugging.md` for `ks-ssh-v2`.*

