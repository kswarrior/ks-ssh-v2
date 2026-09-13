//! End-to-end encryption for the KS SSH relay (sshx-style).
//!
//! Split routing from secrecy:
//! - `token` (5-char, e.g. `ABCDE`): room ID only, sent in URL query + `hello`.
//!   Guessable by design.
//! - `k` (256-bit random, base64url no-pad ~43 chars): E2E secret. Lives ONLY
//!   in the URL fragment (`#/view/ABCDE#k=...`, `/v/ABCDE#k=...`) and agent
//!   memory. NEVER in query string, NEVER in `fetch()` URL, NEVER sent to the
//!   Worker, NEVER logged, NEVER stored in DO / localStorage.
//!
//! Algorithm: AES-256-GCM, 96-bit random nonce per message.
//! - Rust: `aes-gcm` + `getrandom` (CSPRNG; `rand_core` traits compatible).
//! - Web: native `crypto.subtle` AES-GCM only, no new deps.
//! - Key = raw 32 bytes from `k` directly, then HKDF-SHA256 with info
//!   `"ks-ssh-e2e-v1"` for domain separation. No Argon2: `k` is already
//!   256-bit high-entropy from a CSPRNG, so password stretching adds nothing;
//!   HKDF only binds the key to this protocol version.
//! - AAD = `token` bytes (binds ciphertext to the room, blocks cross-room replay).
//! - Salt for HKDF = 32 zero bytes, explicit so Rust and WebCrypto agree
//!   (WebCrypto with an empty salt behaves differently across impls).
//!
//! Envelope (the only relay message type that carries secrets):
//! ```json
//! {"type":"enc","v":1,"seq":123,"nonce":"b64url","ct":"b64url"}
//! ```
//! `ct` = AES-GCM(token as AAD, plaintext JSON). Plaintext JSON is the existing
//! inner protocol (`data`, `resize`, future `pty-out`, file chunks).
//! `seq`: strict increment per direction, reject replays/duplicates.
//! First `seq` = 0 each direction after `hello`.
//!
//! UI bundle exception: `ui-begin`/`ui-chunk`/`ui-end` + `/v/TOKEN` HTML stay
//! PLAINTEXT — it is public build output, needed for fullscreen caching in
//! `room.ts`. Never tunnel secrets inside UI messages.
//!
//! Control plaintext allowed: `hello` (token+role only, no `k`), `paired`,
//! `agent` online/offline, `ping`/`pong`, `ui-request`/`ui-ready`/`ui-pending`/
//! `ui-missing`/`ui-error`/`ui-stored`. Everything sensitive MUST be `enc`.

use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Payload},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Negotiated in `hello`: `{ ..., "e2e": "aes-gcm-v1" }`.
pub const E2E_ALG: &str = "aes-gcm-v1";
/// Envelope version (`"v": 1`).
pub const E2E_VERSION: u32 = 1;
/// HKDF info for domain separation.
pub const HKDF_INFO: &[u8] = b"ks-ssh-e2e-v1";
/// Explicit 32-byte zero salt so Rust and WebCrypto derive the same subkey.
const HKDF_SALT: [u8; 32] = [0u8; 32];

/// Opaque relay envelope. The relay must forward this without inspecting
/// `nonce`/`ct` (see `cf/worker/room.ts`: `// E2E opaque — do not inspect`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub v: u32,
    pub seq: u64,
    /// base64url no-pad, 12 random bytes.
    pub nonce: String,
    /// base64url no-pad, AES-256-GCM ciphertext + 16-byte tag.
    pub ct: String,
}

/// Master secret. Zeroized on drop — never log or persist.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct E2eKey([u8; 32]);

impl std::fmt::Debug for E2eKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("E2eKey(<redacted>)")
    }
}

impl E2eKey {
    /// Fresh 256-bit CSPRNG key.
    pub fn generate() -> anyhow::Result<Self> {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).map_err(|e| anyhow::anyhow!("rng: {e}"))?;
        Ok(Self(raw))
    }

    pub fn from_bytes(raw: [u8; 32]) -> Self {
        Self(raw)
    }

    /// Parse `k` from a URL fragment (base64url, no pad, 32 bytes).
    pub fn from_base64url(s: &str) -> anyhow::Result<Self> {
        let raw = decode_b64url(s)?;
        if raw.len() != 32 {
            anyhow::bail!("bad e2e key length (want 32 bytes)");
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&raw);
        Ok(Self(arr))
    }

    /// Encode `k` for the URL fragment (`#k=...`, never query/fetch/log).
    pub fn to_base64url(&self) -> String {
        encode_b64url(&self.0)
    }

    /// HKDF-SHA256(master, salt=32 zeros, info=`ks-ssh-e2e-v1`) → 32-byte
    /// AES key. Domain separation only — `k` is already high-entropy.
    pub fn derive(&self) -> [u8; 32] {
        let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(&HKDF_SALT), &self.0);
        let mut out = [0u8; 32];
        hk.expand(HKDF_INFO, &mut out)
            .expect("hkdf expand with fixed length");
        out
    }
}

/// Stateful E2E session for one direction pair.
/// `tx_seq` starts at 0; `rx_next` starts at 0. After `hello`, the first
/// message each side sends uses `seq = 0`.
pub struct E2e {
    key: E2eKey,
    token: String,
    tx_seq: u64,
    rx_next: u64,
}

impl E2e {
    pub fn new(key: E2eKey, token: &str) -> Self {
        Self {
            key,
            token: token.to_uppercase(),
            tx_seq: 0,
            rx_next: 0,
        }
    }

    /// Encrypt the next outbound plaintext (inner JSON bytes).
    pub fn encrypt_next(&mut self, plaintext: &[u8]) -> anyhow::Result<Envelope> {
        let seq = self.tx_seq;
        let env = encrypt_with_seq(&self.key, &self.token, seq, plaintext)?;
        self.tx_seq = self.tx_seq.wrapping_add(1);
        Ok(env)
    }

    /// Decrypt the next inbound envelope. Rejects replays/duplicates/
    /// out-of-order (`seq` must equal the expected counter) and wrong-key /
    /// tampered tags. On failure the counter does NOT advance.
    pub fn decrypt_next(&mut self, env: &Envelope) -> anyhow::Result<Vec<u8>> {
        if env.kind != "enc" {
            anyhow::bail!("not an enc envelope");
        }
        if env.v != E2E_VERSION {
            anyhow::bail!("unsupported e2e version");
        }
        if env.seq != self.rx_next {
            anyhow::bail!("replay/duplicate/out-of-order (got seq {})", env.seq);
        }
        let pt = decrypt_envelope(&self.key, &self.token, env)?;
        self.rx_next = self.rx_next.wrapping_add(1);
        Ok(pt)
    }

    pub fn tx_seq(&self) -> u64 {
        self.tx_seq
    }
    pub fn rx_next(&self) -> u64 {
        self.rx_next
    }
}

/// One-shot encrypt with an explicit `seq` (stateless; prefer `E2e`).
pub fn encrypt_with_seq(
    key: &E2eKey,
    token: &str,
    seq: u64,
    plaintext: &[u8],
) -> anyhow::Result<Envelope> {
    let mut nonce_bytes = [0u8; 12];
    getrandom::fill(&mut nonce_bytes).map_err(|e| anyhow::anyhow!("rng: {e}"))?;
    encrypt_with_nonce(key, token, seq, plaintext, &nonce_bytes)
}

/// Deterministic encrypt with caller-supplied 12-byte nonce.
/// Used for cross-language fixtures (TS roundtrip vector); production code
/// must use random nonces via [`encrypt_with_seq`] / [`E2e::encrypt_next`].
pub fn encrypt_with_nonce(
    key: &E2eKey,
    token: &str,
    seq: u64,
    plaintext: &[u8],
    nonce_bytes: &[u8; 12],
) -> anyhow::Result<Envelope> {
    let subkey = key.derive();
    let cipher = Aes256Gcm::new_from_slice(&subkey).expect("32-byte key");
    let nonce = (*nonce_bytes).into();
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: token.to_uppercase().as_bytes(),
            },
        )
        .map_err(|e| anyhow::anyhow!("encrypt: {e}"))?;
    let mut sk = subkey;
    sk.zeroize();
    Ok(Envelope {
        kind: "enc".to_string(),
        v: E2E_VERSION,
        seq,
        nonce: encode_b64url(nonce_bytes),
        ct: encode_b64url(&ct),
    })
}

/// One-shot decrypt (stateless seq check is done by [`E2e::decrypt_next`]).
/// Wrong key / tampered tag → Err (caller must show generic
/// "E2E decrypt failed" without leaking details).
pub fn decrypt_envelope(
    key: &E2eKey,
    token: &str,
    env: &Envelope,
) -> anyhow::Result<Vec<u8>> {
    if env.kind != "enc" || env.v != E2E_VERSION {
        anyhow::bail!("not an enc envelope");
    }
    let subkey = key.derive();
    let cipher = Aes256Gcm::new_from_slice(&subkey).expect("32-byte key");
    let nonce_raw = decode_b64url(&env.nonce)?;
    if nonce_raw.len() != 12 {
        anyhow::bail!("bad nonce length");
    }
    let ct = decode_b64url(&env.ct)?;
    let nonce_arr: [u8; 12] = nonce_raw
        .try_into()
        .map_err(|_| anyhow::anyhow!("bad nonce length"))?;
    let nonce = nonce_arr.into();
    let pt = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ct,
                aad: token.to_uppercase().as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("E2E decrypt failed"))?;
    let mut sk = subkey;
    sk.zeroize();
    Ok(pt)
}

/// base64url, no pad (for `k`, `nonce`, `ct`).
pub fn encode_b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url no-pad; also accepts standard base64 and padded input
/// for robustness across peers.
pub fn decode_b64url(s: &str) -> anyhow::Result<Vec<u8>> {
    if let Ok(v) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s) {
        return Ok(v);
    }
    if let Ok(v) = base64::engine::general_purpose::URL_SAFE.decode(s) {
        return Ok(v);
    }
    if let Ok(v) = base64::engine::general_purpose::STANDARD.decode(s) {
        return Ok(v);
    }
    // Retry with padding added (some peers pad).
    let mut padded = s.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(&padded)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD.decode(&padded)
        })
        .map_err(|e| anyhow::anyhow!("base64: {e}"))
}

/// Serialize an envelope to a WebSocket text frame.
pub fn envelope_to_text(env: &Envelope) -> anyhow::Result<String> {
    Ok(serde_json::to_string(env)?)
}

/// Parse an inbound text frame as an `enc` envelope (returns None when the
/// frame is not `{"type":"enc",...}` — e.g. control plaintext or legacy).
pub fn parse_envelope(text: &str) -> Option<Envelope> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("enc") {
        return None;
    }
    serde_json::from_value(v).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e2e_roundtrip() {
        let key = E2eKey::from_bytes([7u8; 32]);
        let mut a = E2e::new(key.clone(), "ABCDE");
        let mut b = E2e::new(key, "ABCDE");
        for i in 0..5 {
            let inner = serde_json::json!({"type":"data","data":format!("hello {i}")});
            let pt = serde_json::to_vec(&inner).unwrap();
            let env = a.encrypt_next(&pt).unwrap();
            assert_eq!(env.seq, i);
            let back = b.decrypt_next(&env).unwrap();
            assert_eq!(back, pt);
        }
        assert_eq!(a.tx_seq(), 5);
        assert_eq!(b.rx_next(), 5);
    }

    #[test]
    fn e2e_tamper_rejected() {
        let key = E2eKey::from_bytes([9u8; 32]);
        let mut a = E2e::new(key.clone(), "ABCDE");
        let mut b = E2e::new(key, "ABCDE");
        let env = a
            .encrypt_next(b"{\"type\":\"data\",\"data\":\"secret\"}")
            .unwrap();
        // Flip a ct byte.
        let mut tampered = env.clone();
        let mut ct = decode_b64url(&tampered.ct).unwrap();
        ct[0] ^= 0x01;
        tampered.ct = encode_b64url(&ct);
        assert!(b.decrypt_next(&tampered).is_err());
        // Counter must not have advanced — the genuine message still works.
        assert!(b.decrypt_next(&env).is_ok());
    }

    #[test]
    fn e2e_wrong_key_fails() {
        let k1 = E2eKey::from_bytes([1u8; 32]);
        let k2 = E2eKey::from_bytes([2u8; 32]);
        let mut a = E2e::new(k1, "ABCDE");
        let mut b = E2e::new(k2, "ABCDE");
        let env = a.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        assert!(b.decrypt_next(&env).is_err());
    }

    #[test]
    fn e2e_replay_rejected() {
        let key = E2eKey::from_bytes([3u8; 32]);
        let mut a = E2e::new(key.clone(), "ABCDE");
        let mut b = E2e::new(key, "ABCDE");
        let env = a.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        assert!(b.decrypt_next(&env).is_ok());
        // Replay the same seq → reject.
        assert!(b.decrypt_next(&env).is_err());
    }

    #[test]
    fn e2e_key_base64url_roundtrip() {
        let k = E2eKey::generate().unwrap();
        let s = k.to_base64url();
        // 32 bytes → 43 chars, no padding, URL-safe alphabet.
        assert_eq!(s.len(), 43);
        assert!(!s.contains('='));
        assert!(!s.contains('+') && !s.contains('/'));
        let back = E2eKey::from_base64url(&s).unwrap();
        assert_eq!(back.to_base64url(), s);
    }

    #[test]
    fn e2e_cross_room_rejected() {
        let key = E2eKey::from_bytes([5u8; 32]);
        let mut a = E2e::new(key.clone(), "ABCDE");
        let mut b = E2e::new(key, "FGHIJ");
        let env = a.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        // Same key but different room token (AAD) → tag fails.
        assert!(b.decrypt_next(&env).is_err());
    }
}
