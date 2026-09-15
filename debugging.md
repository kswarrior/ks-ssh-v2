# KS SSH v2 — Full CF + CLI Debugging Guide

> One debug doc for **both** sides: `cf/` (Cloudflare Worker + SPA) and `cli/` (Rust backend + embedded React frontend). Covers architecture, local run, logs, and debugging **directly in the main agent** (no sub-agents).

---

## 0. Debugging Approach — Main Agent Only

Do **all** debugging in the main agent. Do **not** spawn sub-agents (`Task` tool).

### Mandatory Workflow — Read → Understand → Fix → Build

**You MUST follow this order. Do NOT edit or build before reading and understanding.**

**Phase 1 — READ ALL & UNDERSTAND (required first)**
- Read **all** relevant files **fully** before any fix. At minimum: every file in `§3 Logs & Where to Look` + `§8 Files to Watch` plus `§1 Architecture` flows and `§2 Local Run`.
- Trace **both** sides sequentially in main: `cf/` **and** `cli/` — e.g. `cf/src/App.tsx` → `cf/worker/room.ts` → `cf/worker/index.ts` → `cli/frontend/src/App.tsx` → `cli/frontend/src/relay-shim.ts` → `cli/frontend/src/relay-e2e.ts` → `cli/backend/src/relay.rs` → `cli/backend/src/e2e.rs` → `cli/frontend/src/pages/Terminal.tsx` → `cli/backend/src/shell.rs` → `cli/backend/src/ui.rs`.
- Understand the full lifecycle end-to-end: `Visit` (`SSHPage visitUrl -> SshVisitPage` vs raw `/v/` → `room.ts uiHtml` → `relay-shim` → `WSS /v1/client` → `E2E` → `rpc/shell`), `Add/Edit`, `Online` (`/api/ssh/status` / `room.ts:72`), `WSS / E2E seq` / `shell replay v2 &from=off`.
- Use `Grep`/`Glob`/`Read` to collect evidence. Note `file:line` for every finding. No assumptions, no partial reads.

**Phase 2 — FIX (only after Phase 1)**
- Only after you can explain the flow end-to-end, apply fixes directly in main agent.

**Phase 3 — BUILD & VERIFY (only after Phase 2)**
- Then go to build/verify: `tsc -b && vite build`, `bash rebuild.sh`, `wrangler dev`, `RUST_LOG=debug`, smoke tests in `§7`.

### Rules
- Main agent does everything itself — reads, searches, edits, builds, verifies — all in same session, in the order above.
- Do NOT skip Phase 1. Do NOT jump to Fix/Build without reading all files and understanding flows.
- Keep context complete: do not edit with partial file knowledge.

### Example — debugging "Visit 1-3 min vs --port 2-4s" (main only, must Read → Understand → Fix → Build)

```bash
# Phase 1 — READ ALL & UNDERSTAND first (no edits yet):
grep -rn "AUTH_TIMEOUT\|HELLO_TIMEOUT\|RPC_TIMEOUT" cli/frontend/src/App.tsx cli/frontend/src/relay-shim.ts
# Read cf/src/App.tsx:949,1105,1630 + cf/worker/room.ts:46,113,174,398 + cli/frontend/src/App.tsx:141,167,438 + cli/backend/src/ui.rs + cli/backend/src/relay.rs
# Understand: why raw /v/ via shim takes 120s RPC vs --port 50ms direct, check Promise.race 8500/7500
# Phase 2 — FIX only after full understanding
# Phase 3 — BUILD: cd cf && npm run build; cd cli && bash rebuild.sh
```

### Example — debugging "empty terminal reload 60s" (main only, must Read → Understand → Fix → Build)

```bash
# Phase 1 — READ ALL first:
grep -n "STALE_MS\|PING_MS\|backoffMs" cli/frontend/src/pages/Terminal.tsx
# Read cli/frontend/src/pages/Terminal.tsx:40,1528,1579 + cli/backend/src/shell.rs + cli/frontend/src/App.tsx boot
# Understand: STALE 12s + v2 gating + backoff 500*2^a 36.5s before touching code
# Phase 2 — FIX, Phase 3 — BUILD
```

---

## 1. Architecture

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
│   └── limit.ts
└── wrangler.jsonc            release/ks-ssh (single binary)
```

**Flows**

| Flow | CF | CLI |
|------|----|-----|
| `Visit` | `SSHPage visitUrl -> SshVisitPage` or raw `https://…/v/TOKEN#k=` → `room.ts` `uiHtml` | `frontend boot` → `relay-shim installRelayShim()` → `WSS /v1/client?token=` → `agent hello` → `E2E` → `rpc / shell` |
| `Add/Edit` | `SshAddPage`/`SshEditPage` `#/ssh/add` `#/ssh/edit/:id` (real pages) | `Terminal` `v2 &from=off` `sid` persist `localStorage` |
| `Online` | `fetch /api/ssh/status` `room.ts:72 agentOnline` | `fetch /api/terms` `shell.rs` |

---

## 2. Local Run

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

## 3. Logs & Where to Look

| Symptom | Check | File:line |
|---------|-------|-----------|
| `1-3 min` raw open (port 2-4s) | `RPC_TIMEOUT 120s` `HELLO 10s` blocking boot `fetch /api/auth/status` via shim | `cli/frontend/src/App.tsx:167` `cli/frontend/src/relay-shim.ts:24` |
| `second open 4-5s + loading` | `E2E seq` desync `new E2eChannel txSeq 0` vs agent `rx_next N+1` → `decrypt_next seq!=rx_next` → `E2E decrypt failed` → `120s` pending | `cli/backend/src/e2e.rs:317` `cli/backend/src/relay.rs:1108` `cli/frontend/src/relay-e2e.ts:173` |
| `terminal reload 60s` empty | `STALE_MS 12s` kills idle empty (`v2==false` no ping) → `backoff 500*2^a 36.5s` | `cli/frontend/src/pages/Terminal.tsx:40` `1528` |
| `SSH offline stale` | `online` persisted `localStorage ks-ssh:ssh` not rechecked | `cf/src/App.tsx:2400` `737 refreshStatuses` |
| `Visit shows Starting…` | `auth===null` boot gate only `Checking login…` static | `cli/frontend/src/App.tsx:438` |
| `Visit shows CF loader not raw` | `SSHPage href="#/ssh/visit/:id"` vs `visitUrl /v/#k=` | `cf/src/App.tsx:1105` |

**Enable logs**

```bash
# CLI agent
RUST_LOG=debug ./release/ks-ssh --token=TEST --port 8080
# CF Worker
wrangler tail
# Browser
localStorage.debug = 'ks-ssh:*'
# Frontend console
console.warn('KS relay: …') // shim fingerprint mismatch, E2E decrypt failed
```

---

## 4. Debugging Recipes

### 4.1 CF SSH online stale after refresh

```ts
// cf/src/App.tsx:2400 initial state forced offline
.filter(...).map(x=>({...x, online:false}))
// SSHPage:737 refreshStatuses parallel fetch /api/ssh/status?token= per entry, Map→onChange, openWatchSocket for newlyOnline
// Sockets: openWatchSocket per online entry, onclose→online:false, attemptConnect timeout 8000
```

Debug: `curl -s https://…/v1/client?token=TOKEN` (should 426), `curl -s https://…/api/ssh/status?token=TOKEN` → `{"agentOnline":true}`.

### 4.2 Visit raw 1-3 min

```bash
# Before fix: boot awaited fetch via shim with 120s RPC
# After: Promise.race([fetch, timeout 8500/7500]) + isRelay check
grep -n "AUTH_TIMEOUT\|HELLO_TIMEOUT" cli/frontend/src/App.tsx
```

Debug: open `https://…/v/TOKEN#k=` → F12 Network → `auth/status` 3.8s race vs `120s` pending.

### 4.3 Second open E2E fail

```bash
grep -n "reset_seq" cli/backend/src/e2e.rs cli/backend/src/relay.rs
# Must be: on hello from new client, shared.lock().await → reset_seq() + viewer_ok=false
```

Debug: second tab console → `E2E decrypt failed` → check `shared.reset_seq()` added `relay.rs:1201`.

### 4.4 Empty terminal reload 60s

```ts
// Terminal.tsx:40 STALE_MS 45000 (was 12000), backoff 200*2^a capped 2000, MAX_RETRIES 12
// beat 1528 gated if(v2Ref.current && lastMsg>STALE) close
// flush 1579 visibilitychange/pagehide/beforeunload saveOffset()
```

Debug: open empty terminal → wait 15s → reload → Network `v1/shell?v=2&from=` should be `200` not `1011` close.

### 4.5 CF Visit loader (optional)

`cf/src/App.tsx:1630 SshVisitPage` parallel `status + meta` + `WSS 7s` + `fetch /v/` preload, `preconnect link` to `wsHost`, `progress 12→92%` + hidden preload `iframe onLoad→100%` → `visit-frame`. Primary `Visit` now raw `visitUrl` `cf/src/App.tsx:949`.

---

## 5. Fast-Load Checklist

- [ ] `cli/frontend/src/App.tsx` boot `Promise.race` timeout `8500/7500` not `120000`
- [ ] `cli/backend/src/e2e.rs` `reset_seq()` + `relay.rs` hello reset
- [ ] `cli/frontend/src/pages/Terminal.tsx` `STALE 45s` `backoff 200` `v2` gated `flush` on hide
- [ ] `cf/src/App.tsx` `refreshStatuses` `Promise.all` not sequential, `preconnect` hint
- [ ] `cli/release/ks-ssh` rebuilt after `frontend/dist` change (`bash rebuild.sh`)
- [ ] `cf/dist` built (`npm run build`) and `wrangler deploy` if testing live `workers.dev`

---

## 6. Debugging Playbook (Main Agent Only)

**Template to copy-paste**

```md
Task: Debug <symptom>
Steps in main agent:
1. Grep/Read cf/... for <CF part> — note files:lines
2. Grep/Read cli/... for <CLI part> — note files:lines
3. Edit directly, then verify: `tsc -b && vite build` + `bash rebuild.sh`
```

**Current fixes as examples**

| Fix | Where main agent looked | Root cause |
|-----|------------------------|------------|
| `online stale` | `cf/src/App.tsx:2400, 737` | `online` persisted, no recheck |
| `Visit 1-3 min` | `cf/worker/room.ts` + `cli/frontend/src/relay-shim.ts` | `RPC 120s` vs `port 50ms` |
| `2nd open 4-5s` | `cli/backend/src/e2e.rs` `cli/backend/src/relay.rs` `cli/frontend/src/relay-e2e.ts` | `reset_seq` missing |
| `terminal 60s` | `cli/frontend/src/pages/Terminal.tsx:40,1528` | `STALE 12s + backoff 36.5s` |

**How to debug next bug (main only)**

```bash
# All in main agent, sequential:
grep -rn "pattern" cf/src/App.tsx cli/frontend/src/pages/Terminal.tsx
# Read files, edit, then verify:
cd cf && npm run build
cd cli && bash rebuild.sh
```

---

## 7. Verify

```bash
# CF
cd cf && npm run build && npx oxlint

# CLI frontend + embed
cd cli && bash rebuild.sh
# -> dist/index.html 1k, assets/index-*.js 788k, release/ks-ssh 19MB

# Smoke
./release/ks-ssh --port 18080 & curl -s http://127.0.0.1:18080/api/hello | head
./release/ks-ssh --token=TEST --port 18080 & # then open https://…/v/TEST#k=... twice, second should be 2s not 5s, terminal reload after 20s should be <3s
```

---

## 8. Files to Watch

```
cf/src/App.tsx:12,130,637,739,949,1105,1630,2300
cf/worker/room.ts:46,113,174,398
cli/frontend/src/App.tsx:141,167,438
cli/frontend/src/relay-shim.ts:24,240,673
cli/frontend/src/pages/Terminal.tsx:40,1528,1579
cli/backend/src/e2e.rs:236,275
cli/backend/src/relay.rs:299,1108,1191
```

---

*Generated for Muse Spark / opencode — main-agent only, no Task sub-agents.*
