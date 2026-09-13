// E2E fixture check: decrypt the Rust-generated vector with WebCrypto.
// Run: node scripts/e2e-check.mjs  (no deps, Node 20+ with WebCrypto)
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

const kRaw = b64urlDecode(fixture.k)
const token = fixture.token
const env = fixture.envelope

const hkdfKey = await crypto.subtle.importKey('raw', kRaw, 'HKDF', false, ['deriveKey'])
const aes = await crypto.subtle.deriveKey(
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

const ptBuf = await crypto.subtle.decrypt(
  {
    name: 'AES-GCM',
    iv: b64urlDecode(env.nonce),
    additionalData: new TextEncoder().encode(token),
  },
  aes,
  b64urlDecode(env.ct),
)
const pt = new TextDecoder().decode(ptBuf)
if (pt !== fixture.plaintext) {
  console.error(`FAIL: plaintext mismatch\n got: ${pt}\nwant: ${fixture.plaintext}`)
  process.exit(1)
}

// Negative: wrong token (AAD) must fail.
let aadFailed = false
try {
  await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64urlDecode(env.nonce),
      additionalData: new TextEncoder().encode('WRONG'),
    },
    aes,
    b64urlDecode(env.ct),
  )
} catch {
  aadFailed = true
}
if (!aadFailed) {
  console.error('FAIL: cross-room (wrong AAD) decrypted — must fail')
  process.exit(1)
}

// Negative: tampered ct must fail.
const tampered = Buffer.from(b64urlDecode(env.ct))
tampered[0] ^= 1
let tamperFailed = false
try {
  await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: b64urlDecode(env.nonce),
      additionalData: new TextEncoder().encode(token),
    },
    aes,
    tampered,
  )
} catch {
  tamperFailed = true
}
if (!tamperFailed) {
  console.error('FAIL: tampered ct decrypted — must fail')
  process.exit(1)
}

console.log(`ok: Rust vector decrypts (seq=${env.seq} token=${token}) + tamper/AAD rejected`)
