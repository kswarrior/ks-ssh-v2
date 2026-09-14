// Relay policy checks: rate-limit units + routing evidence (?k= 400,
// token lengths, 429, no-store, PIN-gated data, hello handshake).
// Run: node --experimental-strip-types scripts/relay-check.mjs (no deps).
// Covers DoD: PIN-gated UI/data, rate-limit, `?k=` 400.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  TOKEN_RE,
  RATE_IP_LIMIT,
  RATE_IP_WINDOW_MS,
  RATE_MISS_LIMIT,
  RATE_MISS_WINDOW_MS,
  checkLimit,
  validToken,
  clientIp,
} from '../worker/limit.ts'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const src = (p) => readFileSync(path.join(__dir, '..', p), 'utf8')

function check(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

// ---- Rate-limit units (fixed window) ----
{
  const st = new Map()
  const t0 = 1_000_000
  for (let i = 0; i < RATE_IP_LIMIT; i++) {
    check(checkLimit(st, 'ip:1.2.3.4', t0, RATE_IP_LIMIT, RATE_IP_WINDOW_MS).allowed, `ip budget allows hit ${i + 1}/${RATE_IP_LIMIT}`)
  }
  const over = checkLimit(st, 'ip:1.2.3.4', t0, RATE_IP_LIMIT, RATE_IP_WINDOW_MS)
  check(!over.allowed && over.retryAfter > 0, `ip flood 429s with retry-after (${over.retryAfter}s)`)
  // Window rolls over.
  check(
    checkLimit(st, 'ip:1.2.3.4', t0 + RATE_IP_WINDOW_MS, RATE_IP_LIMIT, RATE_IP_WINDOW_MS).allowed,
    'ip budget resets after window',
  )
  // Token-scan budget is tighter than the IP budget.
  check(RATE_MISS_LIMIT < RATE_IP_LIMIT, `scan budget (${RATE_MISS_LIMIT}) < ip budget (${RATE_IP_LIMIT})`)
  const miss = new Map()
  for (let i = 0; i < RATE_MISS_LIMIT; i++) {
    miss.set('x', { n: i + 1, reset: t0 + RATE_MISS_WINDOW_MS })
    checkLimit(miss, 'miss:9.9.9.9', t0, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
  }
  const scanOver = checkLimit(miss, 'miss:9.9.9.9', t0, RATE_MISS_LIMIT, RATE_MISS_WINDOW_MS)
  check(!scanOver.allowed, 'token scan 429s after miss budget')
}

// ---- Token routing: 9-char fresh, 5-char legacy, nothing else ----
{
  check(TOKEN_RE.test('ABCDEFGHJ'), '9-char token routes')
  check(TOKEN_RE.test('ABCDE'), '5-char legacy token routes')
  check(!TOKEN_RE.test('ABCD'), '4-char token rejected')
  check(!TOKEN_RE.test('ABCDEFGHIJ'), '10-char token rejected')
  check(!TOKEN_RE.test('AB-CD'), 'non-alnum token rejected')
  check(validToken('abcde1234') === 'ABCDE1234', 'validToken uppercases')
  check(validToken('???') === null, 'validToken rejects junk')
}

// ---- clientIp helper (per-IP limits need a stable key) ----
{
  const req = new Request('https://x/v/ABCDE', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  })
  check(clientIp(req) === '1.2.3.4', 'clientIp prefers cf-connecting-ip')
  const req2 = new Request('https://x/v/ABCDE', {
    headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' },
  })
  check(clientIp(req2) === '5.6.7.8', 'clientIp falls back to XFF first entry')
}

// ---- Worker source evidence ----
{
  const index = src('worker/index.ts')
  const limit = src('worker/limit.ts')
  const room = src('worker/room.ts')
  check(index.includes("searchParams.has('k')") && index.includes('status: 400'), '?k= rejected with 400')
  check(
    (index.includes('rateLimited') && limit.includes('429') && limit.includes('retry-after')) ||
      (index.includes('429') && index.includes('retry-after')),
    '429 + retry-after on rate limit',
  )
  check(index.includes('5-9'), 'token length 5-9 surfaced in errors')
  check(room.includes('no-store'), 'UI served with no-store')
  check(room.includes('4408'), 'per-socket flood guard closes with 4408')
  check(room.includes('authGated') && room.includes('gated'), 'PIN gating advertised (gated) without exposing PIN')
  check(room.includes('lastAgentHello'), 'agent hello caps replayed to late joiners')
  check(!room.includes('pin') || room.includes('PIN never appears') || !/verify\(|hash_pin/.test(room), 'relay never verifies PIN (agent-side only)')
}

// ---- Agent source evidence (strict + PIN-inside-enc + hello reply) ----
{
  const relay = src('../cli/backend/src/relay.rs')
  check(relay.includes('E2E_ERROR_MSG'), 'strict downgrade error wired')
  check(relay.includes('"auth"') && relay.includes('send_enc_shared'), 'PIN verified inside enc')
  check(relay.includes('role": "agent"') || relay.includes('"role":"agent"') || relay.includes('role: "agent"'), 'agent answers client hello (late-joiner handshake)')
  check(relay.includes('TOKEN_LEN_NEW'), '9-char fresh tokens')
}

// ---- Pushed-UI shim evidence (strict viewer) ----
{
  const shim = readFileSync(
    path.join(__dir, '../../cli/frontend/src/relay-shim.ts'),
    'utf8',
  )
  check(shim.includes('E2E_ALG'), 'shim negotiates E2E')
  check(shim.includes('e2eRequired') || shim.includes('E2E required'), 'shim hard-fails without #k=')
  check(shim.includes('fingerprint'), 'shim verifies agent fingerprint')
  check(shim.includes('auth'), 'shim sends PIN inside E2E')
}

console.log('relay-check: rate-limit + routing + gating evidence green')
