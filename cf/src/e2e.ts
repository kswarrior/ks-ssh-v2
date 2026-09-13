/**
 * E2E encryption for the KS SSH relay (sshx-style), WebCrypto only.
 *
 * Split routing from secrecy:
 * - `token` (5-char): room ID only, in URL query + `hello`. Guessable.
 * - `k` (256-bit, base64url no-pad ~43 chars): E2E secret. Lives ONLY in the
 *   URL fragment (`#/view/ABCDE#k=...`, `/v/ABCDE#k=...`) and memory.
 *   NEVER in query string, NEVER in fetch() URL, NEVER sent to the Worker,
 *   NEVER logged, NEVER stored in DO / localStorage.
 *
 * Algorithm: AES-256-GCM, 96-bit random nonce per message.
 * - Key = raw 32 bytes from `k`, then HKDF-SHA256(info="ks-ssh-e2e-v1",
 *   salt=32 zero bytes) for domain separation. No Argon2: `k` is already
 *   high-entropy from a CSPRNG; HKDF only binds the key to this protocol.
 * - AAD = `token` bytes (binds ciphertext to the room).
 * - Envelope: `{"type":"enc","v":1,"seq":N,"nonce":"b64url","ct":"b64url"}`.
 *   `seq` starts at 0 per direction after `hello`; strict increment, reject
 *   replays/duplicates. Wrong key / tampered tag -> throw generic
 *   "E2E decrypt failed" (no details).
 *
 * UI bundle exception: ui-begin/ui-chunk/ui-end + /v/TOKEN HTML stay
 * PLAINTEXT (public build output, needed for fullscreen caching in room.ts).
 * Never tunnel secrets inside UI messages.
 */

export const E2E_ALG = 'aes-gcm-v1'
export const E2E_VERSION = 1
export const HKDF_INFO = 'ks-ssh-e2e-v1'

export type E2eStatus = 'on' | 'off' | 'error'

export type EncEnvelope = {
  type: 'enc'
  v: number
  seq: number
  nonce: string
  ct: string
}

const B64URL_RE = /^[A-Za-z0-9_-]{40,50}$/

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/** base64url no-pad encode. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
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

/**
 * Extract `k` from the URL fragment ONLY (never query/fetch).
 * Supports `#/view/ABCDE#k=...`, `#/view/ABCDE&k=...`, `#k=...`, `/v/ABCDE#k=...`
 * (where location.hash is `#k=...`). Returns null when absent/invalid.
 * The caller must never persist or transmit this value except inside
 * AES-GCM ciphertext.
 */
export function parseFragmentKey(hash?: string): string | null {
  try {
    const h = typeof hash === 'string' ? hash : window.location.hash || ''
    // k= appears inside the fragment; take the last occurrence.
    const m = h.match(/[?#&;]k=([A-Za-z0-9_-]{40,50})/)
    const k = m?.[1] ?? null
    if (k && B64URL_RE.test(k)) {
      // Validate it decodes to 32 bytes.
      const raw = b64urlDecode(k)
      if (raw.length === 32) return k
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract `k` from user-pasted text (full share link). Used for the
 * "Paste the full link with #k=..." prompt. Same validation as fragment;
 * never fetches anything over HTTP to obtain the key.
 */
export function extractKeyFromText(text: string): string | null {
  try {
    const m = String(text).match(/[#?&;]k=([A-Za-z0-9_-]{40,50})/)
    const k = m?.[1] ?? (B64URL_RE.test(text.trim()) ? text.trim() : null)
    if (k && B64URL_RE.test(k)) {
      if (b64urlDecode(k).length === 32) return k
    }
    return null
  } catch {
    return null
  }
}

/** Derive the AES-256-GCM CryptoKey via HKDF-SHA256 (salt 32 zeros). */
async function deriveAesKey(masterB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(masterB64)
  if (raw.length !== 32) throw new Error('bad e2e key length')
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveKey'],
  )
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
 * Stateful E2E session (one per WebSocket). `txSeq`/`rxNext` start at 0
 * after `hello`. Use `create()` (async HKDF) then `encryptNext`/`decryptNext`.
 */
export class E2eSession {
  private aes: CryptoKey
  private token: string
  private txSeq = 0
  private rxNext = 0

  private constructor(aes: CryptoKey, token: string) {
    this.aes = aes
    this.token = token.toUpperCase()
  }

  static async create(masterB64: string, token: string): Promise<E2eSession> {
    const aes = await deriveAesKey(masterB64)
    return new E2eSession(aes, token)
  }

  getTxSeq(): number {
    return this.txSeq
  }
  getRxNext(): number {
    return this.rxNext
  }

  /** Seal inner JSON bytes/string into the next `enc` envelope. */
  async encryptNext(plaintext: string | Uint8Array): Promise<EncEnvelope> {
    const pt = typeof plaintext === 'string' ? utf8(plaintext) : plaintext
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(nonce)
    const ctBuf = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer,
        additionalData: utf8(this.token).buffer as ArrayBuffer,
      },
      this.aes,
      (typeof plaintext === 'string' ? pt.buffer : (pt as Uint8Array).buffer) as ArrayBuffer,
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
   * Open the next `enc` envelope. Requires `seq === rxNext` (strict
   * increment); rejects replays/duplicates/out-of-order and wrong-key /
   * tampered tags with a generic Error (caller shows "E2E decrypt failed").
   */
  async decryptNext(env: EncEnvelope): Promise<Uint8Array> {
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
          additionalData: utf8(this.token).buffer as ArrayBuffer,
        },
        this.aes,
        ct.buffer as ArrayBuffer,
      )
      this.rxNext += 1
      return new Uint8Array(ptBuf)
    } catch {
      throw new Error('E2E decrypt failed')
    }
  }
}

/** True when a parsed JSON value is an `enc` envelope (outer type only). */
export function isEncEnvelope(v: unknown): v is EncEnvelope {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return o['type'] === 'enc'
}
