# KS SSH — Cloudflare frontend + relay (`cf/`)

Live browser UI + WSS relay for the `ks-ssh` agent. No demos, no stubs — every
route and page below is wired to the real relay.

## What lives here

- `src/App.tsx` — SPA pages: Home (live relay health + your real connections +
  how-it-works), SSH (token list with live WSS presence + HTTP
  `/api/ssh/status` refresh), Session (fullscreen agent UI over WSS with E2E),
  Installation (real install/relay/PIN commands + live health), Settings
  (relay host, timeout, E2E requirement, theme, clear-data — all take effect
  immediately).
- `src/e2e.ts` — AES-256-GCM E2E (WebCrypto only, `#k=` fragment only).
- `worker/index.ts` — routes: `/v1/agent`, `/v1/client` (WSS), `/v/TOKEN`,
  `/api/ui/*`, `/api/ssh/status?token=`, `/api/relay/TOKEN/status`,
  `/api/health`. Rejects `?k=` with 400. Rate-limits scans with 429.
- `worker/room.ts` — Durable Object per token: pairs one agent with clients,
  caches the pushed UI bundle, replays hello caps, reports
  `agentOnline/hasUi/gated` via `?ui=status`.
- `scripts/e2e-check.mjs` + `scripts/relay-check.mjs` — conformance (vectors,
  negatives, routing, gating, no-fake guards). Run via `npm run test:e2e`.

## Develop

```sh
npm install
npm run dev        # Vite + Cloudflare plugin
npm run lint       # oxlint
npm run build      # tsc + vite build -> dist/client
```

## Test

```sh
npm run test:e2e
# e2e-check: Rust vectors decrypt + tamper/wrong-key/replay/cross-room fail
# relay-check: rate-limit units + token routing + ?k= 400 + gating + no-fake guards
```

## Deploy

```sh
npm run deploy     # wrangler deploy (Worker + DO + static SPA)
npx wrangler types # regenerate worker-configuration.d.ts
```

`wrangler.jsonc` binds DO `TUNNEL` (`TunnelRoom`, sqlite, tag `v1`) and serves
`./dist/client` with SPA fallback.

## Real end-to-end flow

```sh
# on the machine:
curl -sSfL https://raw.githubusercontent.com/kswarrior/ks-ssh-v2/refs/heads/main/cli/release/ks-ssh -o ks-ssh \
  && chmod +x ks-ssh
./ks-ssh --no-serve --token=     # prints /v/TOKEN#k=SECRET + fingerprint
# in this UI: SSH -> Connect -> paste token -> Visit (from the full #k= link)
```

Health: `GET /api/health` → `{ ok, service, now }`.
Status: `GET /api/ssh/status?token=ABCDE` → `{ ok, agentOnline, hasUi, gated }`.
