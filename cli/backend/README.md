# KS SSH backend (Rust)

Local UI: `cargo run -p ks-ssh -- --port 8080`
Relay (no open port): `cargo run -p ks-ssh -- --no-serve --token=`
Relay + local UI: `cargo run -p ks-ssh -- --token=`
Full build: `../rebuild.sh` → `../release/ks-ssh`

## Fullscreen UI via CF relay

The agent pushes its whole embedded frontend as a single-file HTML bundle
over WSS to `https://ks-ssh-v2.kswarriorpro.workers.dev` (see `--relay`):

```
./ks-ssh --no-serve --token=ABCDE1234
# ╭────────────────────────────────────────────────────────╮
# │ KS SSH - ready                                         │
# │ Serve   OFF (--no-serve, no open port)                 │
# │ Token   ABCDE1234                                      │
# │ E2E     ON (AES-256-GCM)                               │
# │ E2E key <SECRET>                                       │
# │ Finger  <16-hex> (verify in viewer, TOFU)              │
# │ Link    https://ks-ssh-v2.kswarriorpro.workers.dev/v/ABCDE1234#k=<SECRET>
# │ Link    https://ks-ssh-v2.kswarriorpro.workers.dev/#/session/ABCDE1234#k=<SECRET>
# │ Login   OFF (open access)                              │
# ╰────────────────────────────────────────────────────────╯
# With --no-e2e the panel shows `E2E  OFF (relay-visible)` and links
# without `#k=...` instead. With `--port` it shows `URL  http://127.0.0.1:8080`.
# Visit in CF opens the full CLI UI (Terminal, Files, Ports, Host) over WSS —
# same as --port, fully functional (no open port needed).
```

Visit-over-WSS is fully functional: the pushed bundle runs in relay mode
and tunnels `/api/*` (`rpc-begin/chunk/end`) plus `/v1/shell` PTY
(`shell-open/send/close`) over the same WSS to a loopback-only server in
the agent process (same router, auth, DB and shells as `--port`). Login
(`--user/--pass`) works over the relay via the agent cookie jar; file
downloads and media previews are re-fetched as relay blobs. Bodies are
chunked at 48KB raw (32MB cap per request/response).

E2E (sshx-style): `token` routes, `k` (fragment-only `#k=...`) seals.
Sensitive relay payloads are `enc` (AES-256-GCM, AAD=token, seq from 0).
`hello` negotiates `{e2e:"aes-gcm-v1"}`; legacy peers fall back to plaintext
with a `⚠️ relay-visible` banner. `--no-e2e` forces legacy;
`--e2e-key=<SECRET>` reuses a key, otherwise `--token=` auto-generates `k`.

CF caches the bundle per token (Durable Object) and serves it:

- `GET /v/<TOKEN>` — raw HTML, iframe/fullscreen friendly
- `GET /api/ui/<TOKEN>/meta` — `{ hasUi, size, updatedAt }`
- `GET /api/ui/<TOKEN>/html` — same HTML (fetch + srcdoc friendly)
- WSS `/v1/client?token=` — `ui-request` → chunked `ui-begin/chunk/end`,
  live `ui-ready` reload; SSH page shows a Fullscreen button when ready.

Skip the upload with `--no-ui` (relay-only, no fullscreen).
