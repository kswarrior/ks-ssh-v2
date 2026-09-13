# KS SSH backend (Rust)

Local UI: `cargo run -p ks-ssh -- --port 8080`
Relay (no open port): `cargo run -p ks-ssh -- --no-serve --token=`
Relay + local UI: `cargo run -p ks-ssh -- --token=`
Full build: `../rebuild.sh` → `../release/ks-ssh`

## Fullscreen UI via CF relay

The agent pushes its whole embedded frontend as a single-file HTML bundle
over WSS to `https://ks-ssh-v2.kswarriorpro.workers.dev` (see `--relay`):

```
./ks-ssh --no-serve --token=ABCDE
# Fullscreen UI: https://ks-ssh-v2.kswarriorpro.workers.dev/v/ABCDE
#            or: https://ks-ssh-v2.kswarriorpro.workers.dev/#/view/ABCDE
```

CF caches the bundle per token (Durable Object) and serves it:

- `GET /v/<TOKEN>` — raw HTML, iframe/fullscreen friendly
- `GET /api/ui/<TOKEN>/meta` — `{ hasUi, size, updatedAt }`
- `GET /api/ui/<TOKEN>/html` — same HTML (fetch + srcdoc friendly)
- WSS `/v1/client?token=` — `ui-request` → chunked `ui-begin/chunk/end`,
  live `ui-ready` reload; SSH page shows a Fullscreen button when ready.

Skip the upload with `--no-ui` (relay-only, no fullscreen).
