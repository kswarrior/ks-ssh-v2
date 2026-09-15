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
//! Control plaintext allowed: `hello` (token+role+e2e/epoch/sess/fp only,
//! no `k`, no PIN), `paired`, `agent` online/offline, `ping`/`pong`,
//! `ui-request`/`ui-ready`/`ui-pending`/`ui-missing`/`ui-error`/`ui-stored`.
//! Everything sensitive MUST be `enc`. The viewer PIN travels ONLY inside
//! `enc` as `{"type":"auth","pin":"..."}` (never plaintext `hello`);
//! plaintext `pin` in `hello` is legacy and ignored when both sides do E2E.
//!
//! Session binding (reconnect-safe, reflection-safe):
//! - The agent mints a random `sess` id per process run and an `epoch` per
//!   connection (0,1,2…), advertised in `hello`.
//! - AAD = `TOKEN` for legacy peers (empty session, epoch 0, no direction),
//!   else `TOKEN|sess|dir|epoch` with `dir` = `a2c` (agent→client) or
//!   `c2a` (client→agent). Cross-session / cross-epoch / reflected
//!   ciphertext fails the GCM tag by construction.
//! - `seq` stays strictly increasing per direction within one
//!   (sess,epoch,dir); a reconnect bumps `epoch`, so old-epoch replays can
//!   never satisfy the new AAD even if `seq` restarts at 0.
//! - Inner plaintexts carry a random `_pad` (0–64 bytes) to blur sizes.
//!
//! Identity: `E2eKey::fingerprint()` = hex(SHA-256(`ks-ssh-e2e-fp-v1` ‖ raw))
//! truncated to 16 chars. The CLI prints it at startup and advertises it as
//! `fp` in `hello`; the viewer computes the same from `#k=` and hard-fails
//! on mismatch (TOFU: first-seen fp remembered per token, warn on change).

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
/// Fingerprint domain separation (`fp` in `hello`, CLI startup line).
pub const FP_INFO: &[u8] = b"ks-ssh-e2e-fp-v1";
/// Direction labels for session-bound AAD.
pub const DIR_A2C: &str = "a2c";
pub const DIR_C2A: &str = "c2a";
/// Generic downgrade error (no details — never leak which side/tag failed).
pub const E2E_ERROR_MSG: &str =
    "E2E error: peer without E2E — refusing plaintext (relay would see secrets)";
/// Cap per decrypted inner plaintext (chunks stay far below this).
pub const MAX_ENC_PLAINTEXT: usize = 512 * 1024;
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

    #[allow(dead_code)]
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

    /// Agent fingerprint for TOFU: hex(SHA-256(`ks-ssh-e2e-fp-v1` ‖ raw)),
    /// truncated to 16 chars. Printed by the CLI, advertised as `fp` in
    /// `hello`, recomputed by the viewer from `#k=` (never transmitted as
    /// a secret — it only binds the identity both sides already share).
    pub fn fingerprint(&self) -> String {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(FP_INFO);
        h.update(self.0);
        let sum = h.finalize();
        hex_of(&sum[..8])
    }
}

/// Lowercase hex of bytes.
fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap_or('0'));
    }
    s
}

/// Fresh random session id (16 bytes → 32 hex chars) minted per agent run.
/// Advertised in `hello` as `sess`; binds AAD so cross-session replays fail.
pub fn new_session_id() -> String {
    let mut raw = [0u8; 16];
    if getrandom::fill(&mut raw).is_err() {
        // Fallback (still unique per call): time + process id mixed.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in raw.iter_mut().enumerate() {
            *b = ((t >> (8 * (i % 8))) ^ (std::process::id() as u128) ^ (i as u128 * 31)) as u8;
        }
    }
    hex_of(&raw)
}

/// AAD for AES-GCM. Legacy peers (empty session, empty dir, epoch 0) bind
/// only the room token; session peers bind `TOKEN|sess|dir|epoch`.
pub fn aad(token: &str, session: &str, dir: &str, epoch: u64) -> Vec<u8> {
    let t = token.to_uppercase();
    if session.is_empty() && dir.is_empty() && epoch == 0 {
        return t.into_bytes();
    }
    format!("{t}|{session}|{dir}|{epoch}").into_bytes()
}

/// Strict-by-default: E2E-on locally requires the peer to advertise E2E.
/// `false` → hard-fail with [`E2E_ERROR_MSG`] + audit, never send plaintext.
pub fn strict_peer_ok(e2e_on: bool, peer_e2e: bool) -> bool {
    if e2e_on { peer_e2e } else { true }
}

/// Insert a random `_pad` (0–64 bytes, base64url) into an inner plaintext
/// JSON value to blur ciphertext sizes. No-op for non-objects.
pub fn add_padding(value: &mut serde_json::Value) {
    let obj = match value.as_object_mut() {
        Some(o) => o,
        None => return,
    };
    if obj.contains_key("_pad") {
        return;
    }
    let mut n = [0u8; 1];
    let len = if getrandom::fill(&mut n).is_ok() {
        (n[0] % 65) as usize
    } else {
        16
    };
    if len == 0 {
        return;
    }
    let mut raw = vec![0u8; len];
    if getrandom::fill(&mut raw).is_err() {
        for (i, b) in raw.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(37).wrapping_add(11);
        }
    }
    obj.insert(
        "_pad".to_string(),
        serde_json::Value::String(encode_b64url(&raw)),
    );
}

/// Stateful E2E session for one direction pair.
/// `tx_seq` starts at 0; `rx_next` starts at 0. After `hello`, the first
/// message each side sends uses `seq = 0` within its `(sess, epoch, dir)`.
/// A reconnect bumps `epoch` (new AAD), so old-epoch replays fail even
/// though `seq` restarts at 0.
pub struct E2e {
    key: E2eKey,
    token: String,
    session: String,
    epoch: u64,
    tx_dir: String,
    rx_dir: String,
    tx_seq: u64,
    rx_next: u64,
}

impl E2e {
    pub fn new(key: E2eKey, token: &str) -> Self {
        Self {
            key,
            token: token.to_uppercase(),
            session: String::new(),
            epoch: 0,
            tx_dir: String::new(),
            rx_dir: String::new(),
            tx_seq: 0,
            rx_next: 0,
        }
    }

    /// Session-bound endpoint. `is_agent` picks direction labels:
    /// agent tx=`a2c`/rx=`c2a`, client mirrored. Both sides must agree on
    /// the agent-minted `(session, epoch)` from `hello`.
    pub fn new_session(
        key: E2eKey,
        token: &str,
        session: &str,
        epoch: u64,
        is_agent: bool,
    ) -> Self {
        let (tx_dir, rx_dir) = if is_agent {
            (DIR_A2C.to_string(), DIR_C2A.to_string())
        } else {
            (DIR_C2A.to_string(), DIR_A2C.to_string())
        };
        Self {
            key,
            token: token.to_uppercase(),
            session: session.to_string(),
            epoch,
            tx_dir,
            rx_dir,
            tx_seq: 0,
            rx_next: 0,
        }
    }

    /// Encrypt the next outbound plaintext (inner JSON bytes).
    pub fn encrypt_next(&mut self, plaintext: &[u8]) -> anyhow::Result<Envelope> {
        if plaintext.len() > MAX_ENC_PLAINTEXT {
            anyhow::bail!("enc plaintext too large");
        }
        let seq = self.tx_seq;
        let env = encrypt_bound(
            &self.key,
            &self.token,
            &self.session,
            &self.tx_dir,
            self.epoch,
            seq,
            plaintext,
            None,
        )?;
        self.tx_seq = self.tx_seq.wrapping_add(1);
        Ok(env)
    }

    /// Decrypt the next inbound envelope. Rejects replays/duplicates/
    /// out-of-order (`seq` must equal the expected counter) and wrong-key /
    /// tampered / cross-session / cross-epoch / reflected tags. On failure
    /// the counter does NOT advance.
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
        let pt = decrypt_bound(
            &self.key,
            &self.token,
            &self.session,
            &self.rx_dir,
            self.epoch,
            env,
        )?;
        if pt.len() > MAX_ENC_PLAINTEXT {
            anyhow::bail!("enc plaintext too large");
        }
        self.rx_next = self.rx_next.wrapping_add(1);
        Ok(pt)
    }

    #[allow(dead_code)]
    pub fn tx_seq(&self) -> u64 {
        self.tx_seq
    }
    #[allow(dead_code)]
    pub fn rx_next(&self) -> u64 {
        self.rx_next
    }
    #[allow(dead_code)]
    pub fn session(&self) -> &str {
        &self.session
    }
    #[allow(dead_code)]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

/// One-shot encrypt with an explicit `seq` (stateless; prefer `E2e`).
/// Legacy AAD=token (empty session/epoch/dir) — keeps the published
/// `e2e.fixture.json` vector byte-identical.
#[allow(dead_code)]
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

/// Session-bound one-shot encrypt (explicit `seq`, `sess`, `dir`, `epoch`).
#[allow(clippy::too_many_arguments)] // crypto API: explicit params keep vectors byte-identical
pub fn encrypt_bound(
    key: &E2eKey,
    token: &str,
    session: &str,
    dir: &str,
    epoch: u64,
    seq: u64,
    plaintext: &[u8],
    nonce_override: Option<&[u8; 12]>,
) -> anyhow::Result<Envelope> {
    let nonce_bytes = match nonce_override {
        Some(n) => *n,
        None => {
            let mut nb = [0u8; 12];
            getrandom::fill(&mut nb).map_err(|e| anyhow::anyhow!("rng: {e}"))?;
            nb
        }
    };
    let subkey = key.derive();
    let cipher = Aes256Gcm::new_from_slice(&subkey).expect("32-byte key");
    let nonce = nonce_bytes.into();
    let aad_bytes = aad(token, session, dir, epoch);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &aad_bytes,
            },
        )
        .map_err(|e| anyhow::anyhow!("encrypt: {e}"))?;
    let mut sk = subkey;
    sk.zeroize();
    Ok(Envelope {
        kind: "enc".to_string(),
        v: E2E_VERSION,
        seq,
        nonce: encode_b64url(&nonce_bytes),
        ct: encode_b64url(&ct),
    })
}

/// Session-bound one-shot decrypt.
pub fn decrypt_bound(
    key: &E2eKey,
    token: &str,
    session: &str,
    dir: &str,
    epoch: u64,
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
    let aad_bytes = aad(token, session, dir, epoch);
    let pt = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ct,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| anyhow::anyhow!("E2E decrypt failed"))?;
    let mut sk = subkey;
    sk.zeroize();
    Ok(pt)
}

/// Deterministic encrypt with caller-supplied 12-byte nonce.
/// Used for cross-language fixtures (TS roundtrip vector); production code
/// must use random nonces via [`encrypt_with_seq`] / [`E2e::encrypt_next`].
#[allow(dead_code)]
pub fn encrypt_with_nonce(
    key: &E2eKey,
    token: &str,
    seq: u64,
    plaintext: &[u8],
    nonce_bytes: &[u8; 12],
) -> anyhow::Result<Envelope> {
    encrypt_bound(key, token, "", "", 0, seq, plaintext, Some(nonce_bytes))
}

/// One-shot decrypt (stateless seq check is done by [`E2e::decrypt_next`]).
/// Wrong key / tampered tag → Err (caller must show generic
/// "E2E decrypt failed" without leaking details).
#[allow(dead_code)]
pub fn decrypt_envelope(
    key: &E2eKey,
    token: &str,
    env: &Envelope,
) -> anyhow::Result<Vec<u8>> {
    decrypt_bound(key, token, "", "", 0, env)
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
    while !padded.len().is_multiple_of(4) {
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

    #[test]
    fn e2e_session_binding_rejects_cross_session() {
        let key = E2eKey::from_bytes([11u8; 32]);
        let mut agent = E2e::new_session(key.clone(), "ABCDE1234", "sessAAA", 0, true);
        let mut client_ok = E2e::new_session(key.clone(), "ABCDE1234", "sessAAA", 0, false);
        let mut client_other =
            E2e::new_session(key.clone(), "ABCDE1234", "sessBBB", 0, false);
        // Agent tx (a2c) → client rx (mirrored dirs): ok.
        let env = agent.encrypt_next(b"{\"type\":\"shell-recv\"}").unwrap();
        assert!(client_ok.decrypt_next(&env).is_ok());
        // Same key/token/seq but different session id → tag fails.
        let env2 = agent.encrypt_next(b"{\"type\":\"shell-recv\"}").unwrap();
        assert!(client_other.decrypt_next(&env2).is_err());
    }

    #[test]
    fn e2e_direction_reflection_rejected() {
        let key = E2eKey::from_bytes([12u8; 32]);
        let mut agent = E2e::new_session(key.clone(), "ABCDE1234", "sess1", 0, true);
        // Attacker reflects the agent's own a2c ciphertext back at the agent
        // (which expects c2a): AAD dir mismatch → fail.
        let env = agent.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        assert!(agent.decrypt_next(&env).is_err());
    }

    #[test]
    fn e2e_epoch_replay_rejected_across_reconnect() {
        let key = E2eKey::from_bytes([13u8; 32]);
        // Epoch 0 session (first connection).
        let mut agent0 = E2e::new_session(key.clone(), "ABCDE1234", "sess1", 0, true);
        let env0 = agent0.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        // Reconnect bumps epoch; seq restarts at 0 but AAD differs.
        let mut client1 = E2e::new_session(key.clone(), "ABCDE1234", "sess1", 1, false);
        assert!(client1.decrypt_next(&env0).is_err());
        // Fresh epoch-1 traffic works.
        let mut agent1 = E2e::new_session(key.clone(), "ABCDE1234", "sess1", 1, true);
        let env1 = agent1.encrypt_next(b"{\"type\":\"data\"}").unwrap();
        assert!(client1.decrypt_next(&env1).is_ok());
    }

    #[test]
    fn e2e_fixture_vector_stable() {
        // Published cross-language vector stays byte-identical (legacy AAD).
        let k = E2eKey::from_base64url("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
            .unwrap();
        let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let env = encrypt_with_nonce(
            &k,
            "ABCDE",
            7,
            b"{\"type\":\"data\",\"data\":\"hello e2e\"}",
            &nonce,
        )
        .unwrap();
        assert_eq!(env.nonce, "AAECAwQFBgcICQoL");
        assert_eq!(
            env.ct,
            "a2XGzNkSK2_xPULPNdQcR8aq0aRkDcZyAUbLUP51uDkwWZcjKLdEVF_RKQ_rFo5Hy1g"
        );
        let pt = decrypt_envelope(&k, "ABCDE", &env).unwrap();
        assert_eq!(pt, b"{\"type\":\"data\",\"data\":\"hello e2e\"}");
    }

    #[test]
    fn e2e_fingerprint_stable_and_unique() {
        let k1 = E2eKey::from_bytes([21u8; 32]);
        let k2 = E2eKey::from_bytes([22u8; 32]);
        let f1 = k1.fingerprint();
        assert_eq!(f1.len(), 16);
        assert!(f1.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(f1, k1.fingerprint());
        assert_ne!(f1, k2.fingerprint());
    }

    #[test]
    fn e2e_padding_roundtrips() {
        let key = E2eKey::from_bytes([23u8; 32]);
        let mut a = E2e::new_session(key.clone(), "ABCDE1234", "s", 0, true);
        let mut b = E2e::new_session(key, "ABCDE1234", "s", 0, false);
        let mut inner = serde_json::json!({"type":"data","data":"hi"});
        add_padding(&mut inner);
        let pt = serde_json::to_vec(&inner).unwrap();
        let env = a.encrypt_next(&pt).unwrap();
        let back = b.decrypt_next(&env).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&back).unwrap();
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("data"));
    }

    #[test]
    fn e2e_downgrade_rejected_by_strict() {
        assert!(!strict_peer_ok(true, false));
        assert!(strict_peer_ok(true, true));
        assert!(strict_peer_ok(false, false));
        assert!(strict_peer_ok(false, true));
        assert!(E2E_ERROR_MSG.contains("E2E error"));
    }

    #[test]
    fn e2e_aad_legacy_vs_bound() {
        assert_eq!(aad("abcde", "", "", 0), b"ABCDE");
        assert_eq!(
            aad("abcde", "s1", "a2c", 0),
            b"ABCDE|s1|a2c|0"
        );
        assert_eq!(
            aad("ABCDE", "s1", "c2a", 3),
            b"ABCDE|s1|c2a|3"
        );
    }

    #[test]
    fn e2e_session_vector_stable() {
        // Cross-language session vector (AAD=`TOKEN|sess|dir|epoch`).
        // `ct` below was generated with WebCrypto (HKDF-SHA256 salt=32
        // zeros, info=`ks-ssh-e2e-v1`, AES-256-GCM) and must match Rust
        // byte-for-byte — this locks the shared TS/Rust wire format.
        let k = E2eKey::from_base64url("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
            .unwrap();
        assert_eq!(k.fingerprint(), "7508e2b9fe76ad77");
        let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        let env = encrypt_bound(
            &k,
            "ABCDE1234",
            "0123456789abcdef0123456789abcdef",
            "c2a",
            2,
            0,
            b"{\"type\":\"shell-send\",\"id\":\"s1\"}",
            Some(&nonce),
        )
        .unwrap();
        assert_eq!(env.seq, 0);
        assert_eq!(env.nonce, "AAECAwQFBgcICQoL");
        assert_eq!(
            env.ct,
            "a2XGzNkSK2_xKkveOJodFselwedqFY1-RhCFTO8y95eWsHJfdmXQl1NQsaSyEdM"
        );
        // And back: session/dir/epoch-bound decrypt works.
        let pt = decrypt_bound(
            &k,
            "ABCDE1234",
            "0123456789abcdef0123456789abcdef",
            "c2a",
            2,
            &env,
        )
        .unwrap();
        assert_eq!(pt, b"{\"type\":\"shell-send\",\"id\":\"s1\"}");
        // Wrong dir / epoch / session all fail the tag.
        assert!(decrypt_bound(&k, "ABCDE1234", "0123456789abcdef0123456789abcdef", "a2c", 2, &env).is_err());
        assert!(decrypt_bound(&k, "ABCDE1234", "0123456789abcdef0123456789abcdef", "c2a", 3, &env).is_err());
        assert!(decrypt_bound(&k, "ABCDE1234", "ffffffffffffffffffffffffffffffff", "c2a", 2, &env).is_err());
    }

    #[test]
    fn e2e_session_id_unique() {
        let a = new_session_id();
        let b = new_session_id();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
