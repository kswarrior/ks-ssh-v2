/**
 * Session-bound E2E for the relay shim (WebCrypto only, no new deps).
 *
 * Mirrors `cli/backend/src/e2e.rs` exactly:
 * - master `k`: 32 bytes from the URL fragment (`#k=...`, base64url no-pad).
 * - subkey: HKDF-SHA256(salt = 32 zero bytes, info = `ks-ssh-e2e-v1`).
 * - AES-256-GCM, 96-bit random nonce per message.
 * - AAD: `TOKEN` (legacy agents without `sess`) or
 *   `TOKEN|sess|c2a|epoch` (tx) / `TOKEN|sess|a2c|epoch` (rx).
 * - envelope: `{"type":"enc","v":1,"seq":N,"nonce":"b64url","ct":"b64url"}`.
 * - `seq` strict increment per direction from 0 after `hello`.
 * - inner plaintexts carry random `_pad` (0–64 bytes) to blur sizes.
 * - fingerprint: hex(SHA-256(`ks-ssh-e2e-fp-v1` ‖ raw))[0:16] (TOFU).
 *
 * `k` lives ONLY in the fragment and memory — never query/fetch/storage.
 */

export const E2E_ALG = 'aes-gcm-v1'
export const E2E_VERSION = 1
const HKDF_INFO = 'ks-ssh-e2e-v1'
const FP_INFO = 'ks-ssh-e2e-fp-v1'

export type EncEnvelope = {
  type: 'enc'
  v: number
  seq: number
  nonce: string
  ct: string
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** base64url no-pad encode. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url decode (accepts padded/unpadded, url-safe or standard). */
export function b64urlDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4 !== 0) t += '='
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/

function validKey(k: string): boolean {
  if (!KEY_RE.test(k)) return false
  try {
    return b64urlDecode(k).length === 32
  } catch {
    return false
  }
}

/**
 * Read `k` from a URL hash fragment ONLY (never query/fetch).
 * Supports `#/session/ABCDE#k=...`, `#k=...`, `#/v/ABCDE&k=...`.
 */
export function parseKeyFromHash(hash: string): string | null {
  try {
    const m = hash.match(/[?#&;]k=([A-Za-z0-9_-]{40,50})/)
    const k = m?.[1] ?? null
    if (k && validKey(k)) return k
    return null
  } catch {
    return null
  }
}

/**
 * Read the E2E key for relay mode: parent fragment first (CF Visit keeps
 * `#k=` on the parent `#/session/TOKEN` URL — same-origin iframes and
 * srcDoc can read it without duplicating the secret), then our own hash.
 * Returns null when the user opened with a bare token (plaintext peers are
 * refused by default-E2E agents with a clear "open the full link" error).
 */
export function readRelayKey(): string | null {
  try {
    const parentHash = window.parent !== window ? window.parent.location.hash : ''
    if (parentHash) {
      const k = parseKeyFromHash(parentHash)
      if (k) return k
    }
  } catch {
    // Cross-origin parent (future hardening) — fall through to own hash.
  }
  try {
    return parseKeyFromHash(window.location.hash || '')
  } catch {
    return null
  }
}

/** Derive the AES-256-GCM CryptoKey via HKDF-SHA256 (salt 32 zeros). */
async function deriveAesKey(masterB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(masterB64)
  if (raw.length !== 32) throw new Error('bad e2e key length')
  const hkdfKey = await crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32).buffer as ArrayBuffer,
      info: utf8(HKDF_INFO).buffer as ArrayBuffer,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * TOFU fingerprint: hex(SHA-256(`ks-ssh-e2e-fp-v1` ‖ raw))[0:16].
 * Public (advertised in plaintext `hello`) — identifies the key, never a
 * secret. The viewer hard-fails when the agent-advertised fp differs from
 * the locally computed one (wrong `#k=` or MITM).
 */
export async function fingerprint(masterB64: string): Promise<string> {
  const raw = b64urlDecode(masterB64)
  if (raw.length !== 32) throw new Error('bad e2e key length')
  const info = utf8(FP_INFO)
  const preimage = new Uint8Array(info.length + raw.length)
  preimage.set(info, 0)
  preimage.set(raw, info.length)
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', preimage.buffer as ArrayBuffer))
  let hex = ''
  for (let i = 0; i < 8; i++) {
    const b = sum[i] as number
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

/** Insert random `_pad` (0–64 bytes, b64url) to blur ciphertext sizes. */
function addPadding(obj: Record<string, unknown>): void {
  if ('_pad' in obj) return
  const len = Math.floor(Math.random() * 65)
  if (len === 0) return
  const raw = new Uint8Array(len)
  try {
    crypto.getRandomValues(raw)
  } catch {
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 0xff
  }
  obj['_pad'] = b64urlEncode(raw)
}

function aad(token: string, sess: string, dir: string, epoch: number): Uint8Array {
  const t = token.toUpperCase()
  if (!sess && !dir && epoch === 0) return utf8(t)
  return utf8(`${t}|${sess}|${dir}|${epoch}`)
}

/**
 * One E2E channel (one relay WebSocket). Client side: tx dir `c2a`,
 * rx dir `a2c`. `sess`/`epoch` come from the agent's plaintext `hello`
 * (empty `sess` = legacy agent → token-only AAD).
 */
export class E2eChannel {
  private aes: CryptoKey
  private token: string
  private sess: string
  private epoch: number
  private txSeq = 0
  private rxNext = 0

  private constructor(aes: CryptoKey, token: string, sess: string, epoch: number) {
    this.aes = aes
    this.token = token.toUpperCase()
    this.sess = sess
    this.epoch = epoch
  }

  static async create(
    masterB64: string,
    token: string,
    sess: string,
    epoch: number,
  ): Promise<E2eChannel> {
    const aes = await deriveAesKey(masterB64)
    return new E2eChannel(aes, token, sess, epoch)
  }

  /** Seal an inner protocol value into the next `enc` envelope. */
  async seal(value: Record<string, unknown>): Promise<EncEnvelope> {
    const obj: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    addPadding(obj)
    const pt = utf8(JSON.stringify(obj))
    if (pt.length > 512 * 1024) throw new Error('enc plaintext too large')
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(nonce)
    const ctBuf = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer,
        additionalData: aad(this.token, this.sess, 'c2a', this.epoch).buffer as ArrayBuffer,
      },
      this.aes,
      pt.buffer as ArrayBuffer,
    )
    const env: EncEnvelope = {
      type: 'enc',
      v: E2E_VERSION,
      seq: this.txSeq,
      nonce: b64urlEncode(nonce),
      ct: b64urlEncode(new Uint8Array(ctBuf)),
    }
    this.txSeq += 1
    return env
  }

  /**
   * Open the next `enc` envelope. Requires `seq === rxNext` (strict);
   * rejects replays/duplicates/out-of-order and wrong-key/tampered tags
   * with a generic Error (caller shows "E2E decrypt failed").
   */
  async open(env: EncEnvelope): Promise<Record<string, unknown>> {
    if (env?.type !== 'enc' || env?.v !== E2E_VERSION) throw new Error('E2E decrypt failed')
    if (env.seq !== this.rxNext) throw new Error('E2E decrypt failed')
    let nonce: Uint8Array
    let ct: Uint8Array
    try {
      nonce = b64urlDecode(env.nonce)
      ct = b64urlDecode(env.ct)
    } catch {
      throw new Error('E2E decrypt failed')
    }
    if (nonce.length !== 12) throw new Error('E2E decrypt failed')
    try {
      const ptBuf = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce.buffer as ArrayBuffer,
          additionalData: aad(this.token, this.sess, 'a2c', this.epoch).buffer as ArrayBuffer,
        },
        this.aes,
        ct.buffer as ArrayBuffer,
      )
      const parsed = JSON.parse(new TextDecoder().decode(ptBuf)) as Record<string, unknown>
      this.rxNext += 1
      return parsed
    } catch {
      throw new Error('E2E decrypt failed')
    }
  }
}

/** True when a parsed JSON value is an `enc` envelope (outer type only). */
export function isEncEnvelope(v: unknown): v is EncEnvelope {
  if (!v || typeof v !== 'object') return false
  return (v as Record<string, unknown>)['type'] === 'enc'
}
