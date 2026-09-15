# KS SSH v2 — Full CF + CLI Debugging Guide

> One debug doc for **both** sides: `cf/` (Cloudflare Worker + SPA) and `cli/` (Rust backend + embedded React frontend). Covers architecture, local run, logs, and **how to spawn sub-agents** for parallel debugging.

---

## 0. Spawn Sub-Agent for Debugging (how to use `Task`)

You **must** use sub-agents for any open-ended codebase search or multi-file fix. The main agent keeps context short; sub-agents do the heavy lifting.

### When to spawn
- User asks to “check cli and cf both flows” → spawn 2 sub-agents (one `cf/`, one `cli/`).
- Searching for a bug that may be in `cf/src/App.tsx` **and** `cli/frontend/src/pages/Terminal.tsx` **and** `cli/backend/src/relay.rs`.
- Any task with >3 files or >2 hypotheses.

### How to spawn (Task tool)

```ts
// CF flow
task({
  description: "CF Visit loader",
  prompt: "Explore cf/src/App.tsx SshVisitPage, cf/worker/room.ts, cf/worker/index.ts. Find why second Visit is 4-5s and returns loading. Return files:lines.",
  subagent_type: "explore"
})

// CLI flow
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
```

### Rules
- `subagent_type: "explore"` → read-only, fast, thoroughness `quick|medium|very thorough`.
- `subagent_type: "general"` → can edit, run bash, verify.
- Always pass `description` (3-5 words), `prompt` (detailed task + what to return), `subagent_type`.
- Main agent **must not** duplicate work after delegating; wait for result.
- Sub-agents run in parallel — launch them in **one turn** with multiple `task` calls.

### Example — debugging “Visit 1-3 min vs --port 2-4s”

```ts
task({ description: "Trace Visit 1-3min", prompt: "Trace click Visit in cf/src/App.tsx SSHPage visitUrl -> SshVisitPage vs raw /v/ -> cli/frontend/src/App.tsx boot -> relay-shim.ts ensure() RPC 120s. Why does relay take 120s and port 50ms? Check cf/worker/room.ts ensureUiLoaded and cli/backend/src/ui.rs build_single_file. Return timeline.", subagent_type: "explore" })
```

### Example — debugging “empty terminal reload 60s”

```ts
task({ description: "Terminal reload 60s", prompt: "Check cli/frontend/src/pages/Terminal.tsx ShellSession STALE_MS 12s, PING_MS 5s, backoffMs 500*2^a, lastMsgRef, v2Ref, saveOffset 10s throttle. Why does reload <2s fast but >10s slow even empty? Check shell.rs from handling.", subagent_type: "explore" })
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

## 6. Sub-Agent Debugging Playbook

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

*Generated for Muse Spark / opencode — use with `Task` sub-agents for every CF+CLI debug.*
