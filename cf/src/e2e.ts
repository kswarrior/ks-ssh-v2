/**
 * E2E encryption for the KS SSH relay (sshx-style), WebCrypto only.
 *
 * Split routing from secrecy:
 * - `token` (5-char): room ID only, in URL query + `hello`. Guessable.
 * - `k` (256-bit, base64url no-pad ~43 chars): E2E secret. Lives ONLY in the
 *   URL fragment (`#/ssh#k=...`, `#k=...`) and memory.
 *   NEVER in query string, NEVER in fetch() URL, NEVER sent to the Worker,
 *   NEVER logged, NEVER stored in DO / localStorage.
 *
 * Algorithm: AES-256-GCM, 96-bit random nonce per message.
 * - Key = raw 32 bytes from `k`, then HKDF-SHA256(info="ks-ssh-e2e-v1",
 *   salt=32 zero bytes) for domain separation. No Argon2: `k` is already
 *   high-entropy from a CSPRNG; HKDF only binds the key to this protocol.
 * - AAD = `TOKEN` for legacy peers, else `TOKEN|sess|dir|epoch` where the
 *   agent mints `sess` per run and bumps `epoch` per connection, and `dir`
 *   is `a2c` (agent→client) or `c2a` (client→agent). Cross-session /
 *   cross-epoch / reflected ciphertext fails the tag by construction, so
 *   `seq` can safely restart at 0 per connection.
 * - Envelope: `{"type":"enc","v":1,"seq":N,"nonce":"b64url","ct":"b64url"}`.
 *   `seq` starts at 0 per direction per (sess,epoch,dir); strict increment,
 *   reject replays/duplicates. Wrong key / tampered tag -> throw generic
 *   "E2E decrypt failed" (no details).
 * - Inner plaintexts carry a random `_pad` (0–64 bytes) to blur sizes.
 * - Fingerprint = hex(SHA-256("ks-ssh-e2e-fp-v1" ‖ raw))[:16], shown by the
 *   CLI and verified here (TOFU per token, sessionStorage only — never k).
 *
 * Sealed `enc` envelopes stay opaque to the relay — never logged, stored,
 * or inspected beyond the outer `type` for routing. The viewer PIN travels
 * ONLY inside `enc` (`{"type":"auth","pin":"..."}`), never plaintext hello.
 */

export const E2E_ALG = 'aes-gcm-v1'
export const E2E_VERSION = 1
export const HKDF_INFO = 'ks-ssh-e2e-v1'
export const FP_INFO = 'ks-ssh-e2e-fp-v1'
export const DIR_A2C = 'a2c'
export const DIR_C2A = 'c2a'
export const E2E_ERROR_MSG =
  'E2E error: peer without E2E — refusing plaintext (relay would see secrets)'

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
 * Supports `#/ssh#k=...`, `#/ssh&k=...`, `#k=...`
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

/** AAD bytes: legacy `TOKEN`, else `TOKEN|sess|dir|epoch`. */
export function aadBytes(token: string, session: string, dir: string, epoch: number): Uint8Array {
  const t = token.toUpperCase()
  if (!session && !dir && epoch === 0) return utf8(t)
  return utf8(`${t}|${session}|${dir}|${epoch}`)
}

/** Strict-by-default: E2E-on locally requires the peer to advertise E2E. */
export function strictPeerOk(e2eOn: boolean, peerE2e: boolean): boolean {
  return e2eOn ? peerE2e : true
}

/** Fresh random session id (16 bytes → 32 hex chars) — mirrors Rust. */
export function newSessionId(): string {
  const raw = new Uint8Array(16)
  crypto.getRandomValues(raw)
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Random `_pad` (0–64 bytes b64url) blurred into inner plaintext objects. */
export function addPadding(value: Record<string, unknown>): void {
  if ('_pad' in value) return
  const len = Math.floor(Math.random() * 65)
  if (len === 0) return
  const raw = new Uint8Array(len)
  crypto.getRandomValues(raw)
  value['_pad'] = b64urlEncode(raw)
}

/**
 * Fingerprint of `k` for TOFU: hex(SHA-256("ks-ssh-e2e-fp-v1" ‖ raw))[:16].
 * Matches `E2eKey::fingerprint()` in Rust. Not a secret — binds identity.
 */
export async function fingerprintK(masterB64: string): Promise<string> {
  const raw = b64urlDecode(masterB64)
  if (raw.length !== 32) throw new Error('bad e2e key length')
  const data = new Uint8Array(FP_INFO.length + 32)
  data.set(utf8(FP_INFO), 0)
  data.set(raw, FP_INFO.length)
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...sum.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * TOFU check per token: first-seen fingerprint is remembered in
 * sessionStorage (never `k` itself); a changed fp warns of a new key.
 * Returns `{ ok, changed, first }`.
 */
export function checkTofu(token: string, fp: string): { ok: boolean; changed: boolean; first: boolean } {
  const key = `ks-ssh:fp:${token.toUpperCase()}`
  try {
    const prev = sessionStorage.getItem(key)
    if (!prev) {
      sessionStorage.setItem(key, fp)
      return { ok: true, changed: false, first: true }
    }
    if (prev === fp) return { ok: true, changed: false, first: false }
    sessionStorage.setItem(key, fp)
    return { ok: false, changed: true, first: false }
  } catch {
    return { ok: true, changed: false, first: true }
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
 * per (sess,epoch,dir) after `hello`. Use `create()` (async HKDF) then
 * `encryptNext`/`decryptNext`. Session peers bind AAD=`TOKEN|sess|dir|epoch`
 * with mirrored directions (client tx=`c2a`/rx=`a2c`); legacy peers use
 * empty sess/dir + epoch 0 (AAD=`TOKEN`, byte-identical to the old vector).
 */
export class E2eSession {
  private aes: CryptoKey
  private token: string
  private session: string
  private epoch: number
  private txDir: string
  private rxDir: string
  private txSeq = 0
  private rxNext = 0

  private constructor(
    aes: CryptoKey,
    token: string,
    session: string,
    epoch: number,
    txDir: string,
    rxDir: string,
  ) {
    this.aes = aes
    this.token = token.toUpperCase()
    this.session = session
    this.epoch = epoch
    this.txDir = txDir
    this.rxDir = rxDir
  }

  static async create(masterB64: string, token: string): Promise<E2eSession> {
    const aes = await deriveAesKey(masterB64)
    return new E2eSession(aes, token, '', 0, '', '')
  }

  /** Session-bound endpoint (client side: tx=`c2a`, rx=`a2c`). */
  static async createSession(
    masterB64: string,
    token: string,
    session: string,
    epoch: number,
    isAgent: boolean,
  ): Promise<E2eSession> {
    const aes = await deriveAesKey(masterB64)
    const txDir = isAgent ? DIR_A2C : DIR_C2A
    const rxDir = isAgent ? DIR_C2A : DIR_A2C
    return new E2eSession(aes, token, session, epoch, txDir, rxDir)
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
    const bytes = pt instanceof Uint8Array ? pt : new Uint8Array(pt)
    const nonce = new Uint8Array(12)
    crypto.getRandomValues(nonce)
    const aad = aadBytes(this.token, this.session, this.txDir, this.epoch)
    const ctBuf = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.buffer as ArrayBuffer,
        additionalData: aad.buffer as ArrayBuffer,
      },
      this.aes,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
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

  /** Seal a JSON value (with random `_pad`) into the next `enc` envelope. */
  async encryptJson(value: Record<string, unknown>): Promise<EncEnvelope> {
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    addPadding(copy)
    return this.encryptNext(JSON.stringify(copy))
  }

  /**
   * Open the next `enc` envelope. Requires `seq === rxNext` (strict
   * increment); rejects replays/duplicates/out-of-order and wrong-key /
   * tampered / cross-session / cross-epoch / reflected tags with a generic
   * Error (caller shows "E2E decrypt failed").
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
    const aad = aadBytes(this.token, this.session, this.rxDir, this.epoch)
    try {
      const ptBuf = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce.buffer as ArrayBuffer,
          additionalData: aad.buffer as ArrayBuffer,
        },
        this.aes,
        ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer,
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
