# KS SSH — Agent Rules

## 0. Paths
- Backend:  /test/ks-ssh/apps/server   (Go)
- Frontend: /test/ks-ssh/apps/web      (React + TypeScript)
- Shared:   /test/ks-ssh/packages/types
Search only inside the affected part. If the user gives a path, search it FIRST,
then widen within the same part. Never search / or the whole system.

## 1. Plan (before any edit)
1. Classify task: Add | Remove | Fix | Modify | Refactor.
2. Name the affected part(s) and the expected blast radius
   (SSH/SFTP layer? WebSocket protocol? shared types? → then web and server
   are both in scope).
3. Locate real code by grep, not by guess. Read every file you will touch.
4. Check for duplicate/mirrored files; confirm which one is actually imported/built.
5. Before creating a file, confirm no existing file already does the job.
6. Before deleting, grep all references. Never delete DB schema/migration files.
7. Fix tasks: identify the root cause and state it in one line before editing.
   No symptom hiding, no empty catch, no silent fallback.
8. If the requirement is ambiguous or two valid designs exist → ask, don't guess.

## 2. Edit
- Minimal diff. Only files required by the task. No drive-by refactors,
  no reformatting, no renaming unrelated things.
- Follow existing patterns in the surrounding code.
- Database is SQLite. Schema changes must stay backward compatible with
  existing data files. Never edit shipped schema destructively — add a new step.
- SSH core rules:
  * never log/print/return/store passwords, passphrases or private keys in plaintext;
    encrypt secrets at rest
  * host-key verification must not be silently skipped
  * one SSH client per session; multiplex shell/sftp/exec channels over it,
    never leak goroutines or open channels
  * every PTY/WebSocket handler must clean up on disconnect
- WebSocket messages are a contract with apps/web — change both sides together.
- Security-sensitive areas (auth, permissions, tokens, port preview proxy,
  kill/delete/chmod endpoints): fail closed, validate server-side.
- Frontend follows the black/white developer theme, 5px radius.
- Re-read each file after editing it.

## 3. Verify — CHECKLIST V
Run this full checklist, do not look only at changed lines:
- V1 Trace the full flow input → HTTP/WS route → Go handler → ssh/sftp layer
     → remote host → response → frontend consumer. Both directions.
- V2 Every reference to changed symbols/APIs/types/fields updated (grep to prove it),
     including packages/types contracts used by web.
- V3 Contracts match across frontend ↔ server ↔ SQLite ↔ remote host:
     names, casing, nullability, types, status codes, WS message shapes.
- V4 Imports, error handling, edge cases (disconnect mid-transfer, timeout,
     unauthorized, concurrent sessions, large files).
- V5 No duplicate, dead, conflicting or unreachable code left.
- V6 Implementation matches exactly what the user asked — nothing extra, nothing missing.
- V7 Commands:
     Backend:  cd /test/ks-ssh/apps/server && go build ./... && go vet ./... && go test ./...
     Frontend: cd /test/ks-ssh/apps/web && npm run build && npx tsc --noEmit (+ lint if configured)
- V8 Read the REAL command output. Never assume success. Exit code + output or it didn't pass.

## 4. Check passes
- PASS 1: full CHECKLIST V.
- PASS 2: required when the change touches security, auth, SSH/SFTP layer,
  WebSocket protocol, DB schema, API contracts, or more than one part.
  Redo V1–V3 independently (re-read the files, don't trust pass-1 memory)
  and rerun V7.
  For a single-file, single-part, non-security change, PASS 2 = rerun V7 + V2.
- Any failure → find the real cause, fix, restart from PASS 1.

## 5. Build & Run
Only after all required passes:
- Full build:  make build   (single binary, frontend embedded)
- Dev run:     make dev     (go run + vite dev)
Read the actual output. Failure → fix root cause → PASS 1 again.
Never commit binaries or data/ contents.

## 6. Report (short)
Task type | Part(s) | Files changed | Root cause (for Fix) |
Checks + real results | Security notes | Assumptions | Build result
State clearly anything you could NOT verify.
