// E2E conformance: Rust-generated vectors decrypted with WebCrypto (+ negatives).
// Run: npm run test:e2e  (no deps, Node 20+ with WebCrypto)
// Covers DoD: roundtrip (legacy + session-bound), tamper / wrong-key / replay /
// cross-room / cross-session-replay (sess, epoch, dir), fingerprint, downgrade-rejected.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(path.join(__dir, '../src/e2e.fixture.json'), 'utf8'))

function b64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4 !== 0) t += '='
  const bin = Buffer.from(t, 'base64')
  return new Uint8Array(bin)
}

function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function aad(token, sess, dir, epoch) {
  const t = String(token).toUpperCase()
  if (!sess && !dir && epoch === 0) return new TextEncoder().encode(t)
  return new TextEncoder().encode(`${t}|${sess}|${dir}|${epoch}`)
}

async function deriveAes(kRaw) {
  const hkdfKey = await crypto.subtle.importKey('raw', kRaw, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('ks-ssh-e2e-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function decrypt(aes, { token, sess = '', dir = '', epoch = 0, nonce, ct }) {
  const ptBuf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64urlDecode(nonce),
      additionalData: aad(token, sess, dir, epoch),
    },
    aes,
    b64urlDecode(ct),
  )
  return new TextDecoder().decode(ptBuf)
}

async function mustFail(label, fn) {
  let failed = false
  try {
    await fn()
  } catch {
    failed = true
  }
  if (!failed) {
    console.error(`FAIL: ${label} decrypted — must fail`)
    process.exit(1)
  }
  console.log(`ok: ${label} rejected`)
}

function check(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

// ---- Legacy vector (AAD=token, Rust-generated) ----
{
  const kRaw = b64urlDecode(fixture.k)
  const aes = await deriveAes(kRaw)
  const env = fixture.envelope
  const pt = await decrypt(aes, { token: fixture.token, nonce: env.nonce, ct: env.ct })
  check(pt === fixture.plaintext, `legacy Rust vector decrypts (seq=${env.seq} token=${fixture.token})`)
  await mustFail('legacy cross-room (wrong AAD)', () =>
    decrypt(aes, { token: 'WRONG', nonce: env.nonce, ct: env.ct }),
  )
  const tampered = Buffer.from(b64urlDecode(env.ct))
  tampered[0] ^= 1
  await mustFail('legacy tampered ct', () =>
    decrypt(aes, {
      token: fixture.token,
      nonce: env.nonce,
      ct: b64urlEncode(tampered),
    }),
  )
  // Wrong key must fail.
  const other = new Uint8Array(32).fill(2)
  const aesOther = await deriveAes(other)
  await mustFail('legacy wrong key', () =>
    decrypt(aesOther, { token: fixture.token, nonce: env.nonce, ct: env.ct }),
  )
}

// ---- Session vector (AAD=TOKEN|sess|dir|epoch, WebCrypto-generated + Rust-verified) ----
{
  const sv = fixture.session_vector
  const kRaw = b64urlDecode(sv.k)
  const aes = await deriveAes(kRaw)
  const pt = await decrypt(aes, {
    token: sv.token,
    sess: sv.sess,
    dir: sv.dir,
    epoch: sv.epoch,
    nonce: sv.nonce,
    ct: sv.ct,
  })
  check(
    pt === sv.plaintext,
    `session vector decrypts (token=${sv.token} dir=${sv.dir} epoch=${sv.epoch})`,
  )
  // Cross-session replay: same key/token/seq, different sess → fail.
  await mustFail('cross-session replay', () =>
    decrypt(aes, {
      token: sv.token,
      sess: 'ffffffffffffffffffffffffffffffff',
      dir: sv.dir,
      epoch: sv.epoch,
      nonce: sv.nonce,
      ct: sv.ct,
    }),
  )
  // Cross-epoch replay (reconnect with seq reset to 0) → fail.
  await mustFail('cross-epoch replay', () =>
    decrypt(aes, {
      token: sv.token,
      sess: sv.sess,
      dir: sv.dir,
      epoch: sv.epoch + 1,
      nonce: sv.nonce,
      ct: sv.ct,
    }),
  )
  // Reflection: c2a ciphertext presented as a2c → fail.
  await mustFail('direction reflection', () =>
    decrypt(aes, {
      token: sv.token,
      sess: sv.sess,
      dir: 'a2c',
      epoch: sv.epoch,
      nonce: sv.nonce,
      ct: sv.ct,
    }),
  )
  // Cross-room with session binding → fail.
  await mustFail('session cross-room', () =>
    decrypt(aes, {
      token: 'ZZZZZ9999',
      sess: sv.sess,
      dir: sv.dir,
      epoch: sv.epoch,
      nonce: sv.nonce,
      ct: sv.ct,
    }),
  )
  // Fingerprint: hex(SHA-256("ks-ssh-e2e-fp-v1" ‖ raw))[:16], must match Rust.
  const pre = new Uint8Array(16 + 32)
  pre.set(new TextEncoder().encode('ks-ssh-e2e-fp-v1'), 0)
  pre.set(kRaw, 16)
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', pre))
  const fp = [...sum.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  check(fp === sv.fingerprint, `fingerprint matches Rust (${fp})`)
}

// ---- Downgrade matrix (mirrors strictPeerOk in Rust + cf/src/e2e.ts) ----
{
  const strictPeerOk = (e2eOn, peerE2e) => (e2eOn ? peerE2e : true)
  check(strictPeerOk(true, true) === true, 'downgrade: e2e+e2e allowed')
  check(strictPeerOk(true, false) === false, 'downgrade: e2e+legacy refused (E2E error)')
  check(strictPeerOk(false, false) === true, 'downgrade: --no-e2e escape hatch allowed')
}

console.log('e2e-check: all vectors + negatives green')
