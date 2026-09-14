//! Files API: list + download files under the host's HOME directory.
//!
//! The CLI runs on the host, so HOME here means the host user's home
//! (`$HOME`, falling back to `$USERPROFILE` on Windows, then `/`).
//! All requested paths are canonicalized and must stay inside HOME —
//! this keeps the endpoint safe when bound with `--host 0.0.0.0`.

use axum::{
    Json,
    body::{Body, Bytes},
    extract::Query,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::path::{Component, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Deserialize)]
pub struct ListQuery {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    pub path: String,
    /// `?inline=1` serves bytes with `Content-Disposition: inline` so the
    /// browser previews images/video/audio/PDF instead of downloading.
    /// String-based (not bool) so `inline=1` parses from query strings.
    #[serde(default)]
    pub inline: Option<String>,
}

fn inline_requested(q: &DownloadQuery) -> bool {
    match q.inline.as_deref().map(str::trim) {
        Some("1") | Some("true") | Some("yes") | Some("inline") => true,
        _ => false,
    }
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
pub struct SaveBody {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct MkdirBody {
    pub path: String,
}

#[derive(Deserialize)]
pub struct CopyBody {
    pub from: String,
    pub to: String,
}

#[derive(Deserialize)]
pub struct ChmodBody {
    pub path: String,
    pub mode: u32,
}

#[derive(Deserialize)]
pub struct UploadQuery {
    pub dir: String,
    pub name: String,
}

#[derive(Deserialize)]
pub struct UploadUrlBody {
    pub dir: String,
    pub url: String,
    pub name: Option<String>,
}

/// Max bytes returned by the content endpoint (editor is for small text files).
pub const READ_MAX_BYTES: u64 = 1024 * 1024;
/// Max bytes accepted by the save endpoint.
pub const SAVE_MAX_BYTES: usize = 5 * 1024 * 1024;
/// Max bytes accepted per upload (local + URL).
pub const UPLOAD_MAX_BYTES: usize = 100 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    /// Unix permission bits (e.g. 0o755). None on non-unix hosts.
    pub mode: Option<u32>,
    pub is_symlink: bool,
}

#[derive(Serialize)]
pub struct ListResponse {
    pub home: String,
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// Resolve the host HOME directory.
pub fn home_dir() -> PathBuf {
    if let Ok(h) = std::env::var("HOME")
        && !h.trim().is_empty()
    {
        return PathBuf::from(h);
    }
    if let Ok(h) = std::env::var("USERPROFILE")
        && !h.trim().is_empty()
    {
        return PathBuf::from(h);
    }
    PathBuf::from("/")
}

/// Lexically normalize a path (resolve `.`/`..` without touching the FS).
fn normalize(path: &std::path::Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        out
    }
}

/// Resolve a user-supplied path to an absolute dir inside HOME.
///
/// * `None`/empty → HOME.
/// * absolute → must be inside HOME.
/// * relative → joined onto HOME.
fn resolve_inside_home(raw: Option<&str>) -> Result<(PathBuf, PathBuf), (StatusCode, String)> {
    let home = home_dir();
    let home_canon = canonicalize_lossy(&home);

    let joined = match raw.map(str::trim) {
        None | Some("") => home.clone(),
        Some(p) => {
            let pb = PathBuf::from(p);
            if pb.is_absolute() { pb } else { home.join(pb) }
        }
    };
    let normalized = normalize(&joined);
    // Prefer canonicalized form when the path exists (resolves symlinks),
    // otherwise fall back to the lexical normalization.
    let canon = canonicalize_lossy(&normalized);

    if canon != home_canon && !canon.starts_with(&home_canon) {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "path outside HOME ({}): {}",
                home_canon.display(),
                raw.unwrap_or("")
            ),
        ));
    }
    Ok((home_canon, canon))
}

fn canonicalize_lossy(p: &std::path::Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| normalize(p))
}

fn parent_of(home: &PathBuf, dir: &std::path::Path) -> Option<String> {
    let parent = dir.parent()?;
    let s = parent.to_string_lossy().to_string();
    // Stop at HOME — no "up" above it.
    if parent == home {
        return Some(s);
    }
    if s.len() < home.to_string_lossy().len() {
        return None;
    }
    Some(s)
}

fn entry_of(path: PathBuf, meta: std::fs::Metadata) -> FileEntry {
    let is_dir = meta.is_dir();
    let size = if is_dir { 0 } else { meta.len() };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    #[cfg(unix)]
    let mode = Some(
        std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o7777,
    );
    #[cfg(not(unix))]
    let mode: Option<u32> = None;
    let is_symlink = std::fs::symlink_metadata(&path)
        .map(|m| m.is_symlink())
        .unwrap_or(false);
    FileEntry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        is_dir,
        size,
        modified,
        mode,
        is_symlink,
    }
}

/// GET /api/files?path=<abs|rel> — list a directory inside HOME (default: HOME).
pub async fn api_list_files(Query(q): Query<ListQuery>) -> Response {
    let (home, dir) = match resolve_inside_home(q.path.as_deref()) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };

    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (
                StatusCode::NOT_FOUND,
                format!("not found: {}", dir.display()),
            )
                .into_response();
        }
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("cannot read dir: {e}")).into_response();
        }
    };

    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a directory: {}", dir.display()),
        )
            .into_response();
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    for item in read.flatten() {
        let p = item.path();
        let Ok(meta) = item.metadata() else {
            continue;
        };
        // Skip broken names rather than failing the whole listing.
        entries.push(entry_of(p, meta));
    }
    // Directories first, then case-insensitive name order.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let res = ListResponse {
        home: home.to_string_lossy().to_string(),
        path: dir.to_string_lossy().to_string(),
        parent: parent_of(&home, &dir),
        entries,
    };
    (StatusCode::OK, Json(res)).into_response()
}

/// A new file/folder name must be a single path component.
fn valid_file_name(name: &str) -> bool {
    let t = name.trim();
    if t.is_empty() || t == "." || t == ".." {
        return false;
    }
    !t.contains('/') && !t.contains('\\') && !t.contains('\0')
}

/// DELETE /api/files?path=<file|dir> — delete a file or folder inside HOME.
pub async fn api_delete_file(Query(q): Query<DownloadQuery>) -> Response {
    let (home, target) = match resolve_inside_home(Some(&q.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if target == home {
        return (
            StatusCode::BAD_REQUEST,
            "cannot delete HOME itself".to_string(),
        )
            .into_response();
    }
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                format!("not found: {}", target.display()),
            )
                .into_response();
        }
    };
    let res = if meta.is_dir() && !meta.is_symlink() {
        std::fs::remove_dir_all(&target)
    } else {
        std::fs::remove_file(&target)
    };
    match res {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "path": target.to_string_lossy() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot delete {}: {e}", target.display()),
        )
            .into_response(),
    }
}

/// POST /api/files/rename {"from": "...", "to": "..."} — rename/move inside HOME.
pub async fn api_rename_file(Json(b): Json<RenameBody>) -> Response {
    let (home, from) = match resolve_inside_home(Some(&b.from)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let (_, to) = match resolve_inside_home(Some(&b.to)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if from == home {
        return (
            StatusCode::BAD_REQUEST,
            "cannot rename HOME itself".to_string(),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&from).is_err() {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", from.display()),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&to).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", to.display()),
        )
            .into_response();
    }
    let Some(file_name) = to.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return (StatusCode::BAD_REQUEST, "bad destination name".to_string()).into_response();
    };
    if !valid_file_name(&file_name) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid name: {file_name}"),
        )
            .into_response();
    }
    let Some(parent) = to.parent() else {
        return (StatusCode::BAD_REQUEST, "bad destination".to_string()).into_response();
    };
    if !parent.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("destination folder missing: {}", parent.display()),
        )
            .into_response();
    }
    match std::fs::rename(&from, &to) {
        Ok(()) => (
            StatusCode::OK,
            Json(
                serde_json::json!({ "ok": true, "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
            ),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot rename {}: {e}", from.display()),
        )
            .into_response(),
    }
}
/// Recursively copy a file, symlink or directory (stdlib only, no new deps).
fn copy_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_symlink() {
        #[cfg(unix)]
        {
            let target = std::fs::read_link(from)?;
            std::os::unix::fs::symlink(&target, to)?;
            return Ok(());
        }
        #[cfg(not(unix))]
        {
            // No symlink API on this host — fall through and copy the target.
            let _ = meta;
        }
    }
    if std::fs::symlink_metadata(from)?.is_dir() {
        std::fs::create_dir_all(to)?;
        #[cfg(unix)]
        {
            let perm = std::fs::symlink_metadata(from)?.permissions();
            let _ = std::fs::set_permissions(to, perm);
        }
        for item in std::fs::read_dir(from)? {
            let item = item?;
            copy_recursive(&item.path(), &to.join(item.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to)?;
        Ok(())
    }
}

/// POST /api/files/copy {"from": "...", "to": "..."} — copy a file or folder inside HOME.
pub async fn api_copy_file(Json(b): Json<CopyBody>) -> Response {
    let (home, from) = match resolve_inside_home(Some(&b.from)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let (_, to) = match resolve_inside_home(Some(&b.to)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if from == home {
        return (
            StatusCode::BAD_REQUEST,
            "cannot copy HOME itself".to_string(),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&from).is_err() {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", from.display()),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&to).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", to.display()),
        )
            .into_response();
    }
    // Copying a folder into itself (or onto itself) would recurse forever.
    if to.starts_with(&from) {
        return (
            StatusCode::BAD_REQUEST,
            "cannot copy a folder into itself".to_string(),
        )
            .into_response();
    }
    let Some(file_name) = to.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return (StatusCode::BAD_REQUEST, "bad destination name".to_string()).into_response();
    };
    if !valid_file_name(&file_name) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid name: {file_name}"),
        )
            .into_response();
    }
    let Some(parent) = to.parent() else {
        return (StatusCode::BAD_REQUEST, "bad destination".to_string()).into_response();
    };
    if !parent.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("destination folder missing: {}", parent.display()),
        )
            .into_response();
    }
    match copy_recursive(&from, &to) {
        Ok(()) => (
            StatusCode::OK,
            Json(
                serde_json::json!({ "ok": true, "from": from.to_string_lossy(), "to": to.to_string_lossy() }),
            ),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot copy {}: {e}", from.display()),
        )
            .into_response(),
    }
}

/// POST /api/files/chmod {"path": "...", "mode": 493} — set unix permission bits.
pub async fn api_chmod(Json(b): Json<ChmodBody>) -> Response {
    let (_, target) = match resolve_inside_home(Some(&b.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if b.mode > 0o7777 {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid mode: {:o} (want 0..7777 octal)", b.mode),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&target).is_err() {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", target.display()),
        )
            .into_response();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::set_permissions(&target, std::fs::Permissions::from_mode(b.mode)) {
            Ok(()) => (
                StatusCode::OK,
                Json(
                    serde_json::json!({ "ok": true, "path": target.to_string_lossy(), "mode": b.mode }),
                ),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot chmod {}: {e}", target.display()),
            )
                .into_response(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = target;
        (
            StatusCode::NOT_IMPLEMENTED,
            "permissions are only supported on unix hosts".to_string(),
        )
            .into_response()
    }
}
/// GET /api/files/content?path=<file> — read a text file inside HOME for the editor.
/// Returns JSON { path, name, size, modified, kind, content? } where kind is
/// "text" (content included), "binary" (use download), or "too-large".
pub async fn api_read_content(Query(q): Query<DownloadQuery>) -> Response {
    let (_, target) = match resolve_inside_home(Some(&q.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let Ok(meta) = std::fs::metadata(&target) else {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", target.display()),
        )
            .into_response();
    };
    if !meta.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            "only files can be opened".to_string(),
        )
            .into_response();
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let base = serde_json::json!({
        "path": target.to_string_lossy(),
        "name": target.file_name().map(|n| n.to_string_lossy()),
        "size": meta.len(),
        "modified": modified,
    });
    if meta.len() > READ_MAX_BYTES {
        let mut v = base;
        v["kind"] = serde_json::Value::String("too-large".to_string());
        return (StatusCode::OK, Json(v)).into_response();
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read file".to_string(),
        )
            .into_response();
    };
    // NUL byte in the first chunk, or invalid UTF-8 → binary.
    let sniff_len = bytes.len().min(8192);
    if bytes[..sniff_len].contains(&0) || std::str::from_utf8(&bytes).is_err() {
        let mut v = base;
        v["kind"] = serde_json::Value::String("binary".to_string());
        return (StatusCode::OK, Json(v)).into_response();
    }
    // Safe: just validated as UTF-8.
    let text = String::from_utf8(bytes).unwrap_or_default();
    let mut v = base;
    v["kind"] = serde_json::Value::String("text".to_string());
    v["content"] = serde_json::Value::String(text);
    (StatusCode::OK, Json(v)).into_response()
}

/// PUT /api/files/content {"path","content"} — save a text file inside HOME.
pub async fn api_save_content(Json(b): Json<SaveBody>) -> Response {
    let (_, target) = match resolve_inside_home(Some(&b.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if b.content.len() > SAVE_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "content too large (max {} MB)",
                SAVE_MAX_BYTES / 1024 / 1024
            ),
        )
            .into_response();
    }
    if let Ok(meta) = std::fs::symlink_metadata(&target)
        && meta.is_dir()
        && !meta.is_symlink()
    {
        return (
            StatusCode::BAD_REQUEST,
            "cannot overwrite a folder".to_string(),
        )
            .into_response();
    }
    let Some(parent) = target.parent() else {
        return (StatusCode::BAD_REQUEST, "bad path".to_string()).into_response();
    };
    if !parent.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("folder missing: {}", parent.display()),
        )
            .into_response();
    }
    match std::fs::write(&target, b.content.as_bytes()) {
        Ok(()) => (
            StatusCode::OK,
            Json(
                serde_json::json!({ "ok": true, "path": target.to_string_lossy(), "size": b.content.len() }),
            ),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot save {}: {e}", target.display()),
        )
            .into_response(),
    }
}
/// POST /api/files/mkdir {"path": "..."} — create a folder inside HOME.
pub async fn api_mkdir(Json(b): Json<MkdirBody>) -> Response {
    let (_, dir) = match resolve_inside_home(Some(&b.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if std::fs::symlink_metadata(&dir).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", dir.display()),
        )
            .into_response();
    }
    let Some(file_name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return (StatusCode::BAD_REQUEST, "bad folder name".to_string()).into_response();
    };
    if !valid_file_name(&file_name) {
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid name: {file_name}"),
        )
            .into_response();
    }
    match std::fs::create_dir_all(&dir) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "path": dir.to_string_lossy() })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot create {}: {e}", dir.display()),
        )
            .into_response(),
    }
}
/// POST /api/files/upload?dir=<dir>&name=<file> — upload a local file.
/// The request body is the raw file bytes (no multipart needed).
pub async fn api_upload_file(Query(q): Query<UploadQuery>, body: Bytes) -> Response {
    let (_, dir) = match resolve_inside_home(Some(&q.dir)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a folder: {}", dir.display()),
        )
            .into_response();
    }
    let name = q.name.trim();
    if !valid_file_name(name) {
        return (StatusCode::BAD_REQUEST, format!("invalid name: {name}")).into_response();
    }
    if body.len() > UPLOAD_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("file too large (max {} MB)", UPLOAD_MAX_BYTES / 1024 / 1024),
        )
            .into_response();
    }
    let target = dir.join(name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", target.display()),
        )
            .into_response();
    }
    match std::fs::write(&target, &body) {
        Ok(()) => (
            StatusCode::OK,
            Json(
                serde_json::json!({ "ok": true, "path": target.to_string_lossy(), "size": body.len() }),
            ),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot save {}: {e}", target.display()),
        )
            .into_response(),
    }
}

/// Derive a safe file name from a URL's last path segment.
fn filename_from_url(url: &str) -> String {
    let no_frag = url.split('#').next().unwrap_or(url);
    let no_query = no_frag.split('?').next().unwrap_or(no_frag);
    let last = no_query.rsplit('/').next().unwrap_or("").trim();
    // Undo the most common encodings so `my%20file.zip` keeps a sane name.
    let decoded = last.replace("%20", " ");
    if decoded.is_empty() {
        "download".to_string()
    } else {
        decoded
    }
}

fn valid_upload_url(url: &str) -> bool {
    let t = url.trim();
    if t.is_empty() || t.len() > 2048 {
        return false;
    }
    if t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && t[8..].contains('.')
}

/// POST /api/files/upload-url {"dir","url","name"?} — fetch a URL into HOME.
/// Uses `curl` (or `wget` as fallback) on the host, so no extra crates needed.
pub async fn api_upload_url(Json(b): Json<UploadUrlBody>) -> Response {
    let (_, dir) = match resolve_inside_home(Some(&b.dir)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a folder: {}", dir.display()),
        )
            .into_response();
    }
    let url = b.url.trim().to_string();
    if !valid_upload_url(&url) {
        return (
            StatusCode::BAD_REQUEST,
            "only http(s) URLs can be fetched".to_string(),
        )
            .into_response();
    }
    let name = b
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| filename_from_url(&url));
    if !valid_file_name(&name) {
        return (StatusCode::BAD_REQUEST, format!("invalid name: {name}")).into_response();
    }
    let target = dir.join(&name);
    if std::fs::symlink_metadata(&target).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", target.display()),
        )
            .into_response();
    }
    let max_bytes = UPLOAD_MAX_BYTES.to_string();
    // Try curl first, then wget. Args (never a shell) + `--` end option parsing.
    let attempts: Vec<Vec<String>> = vec![
        vec![
            "curl".to_string(),
            "-fsSL".to_string(),
            "--max-time".to_string(),
            "300".to_string(),
            "--max-filesize".to_string(),
            max_bytes.clone(),
            "-o".to_string(),
            target.to_string_lossy().to_string(),
            "--".to_string(),
            url.clone(),
        ],
        vec![
            "wget".to_string(),
            "-q".to_string(),
            "--timeout=300".to_string(),
            "--tries=1".to_string(),
            "-O".to_string(),
            target.to_string_lossy().to_string(),
            "--".to_string(),
            url.clone(),
        ],
    ];
    let mut last_err = "curl/wget not found on host".to_string();
    let mut ok = false;
    for args in &attempts {
        let mut cmd = tokio::process::Command::new(&args[0]);
        cmd.args(&args[1..]);
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                ok = true;
                break;
            }
            Ok(out) => {
                let tail = String::from_utf8_lossy(&out.stderr);
                let tail = tail.trim().lines().last().unwrap_or("fetch failed");
                last_err = format!(
                    "{}: {}",
                    args[0],
                    tail.chars().take(200).collect::<String>()
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                last_err = format!("{}: {e}", args[0]);
            }
        }
    }
    if !ok {
        let _ = std::fs::remove_file(&target);
        return (
            StatusCode::BAD_GATEWAY,
            format!("cannot fetch URL: {last_err}"),
        )
            .into_response();
    }
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if size > UPLOAD_MAX_BYTES as u64 {
        let _ = std::fs::remove_file(&target);
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("file too large (max {} MB)", UPLOAD_MAX_BYTES / 1024 / 1024),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "path": target.to_string_lossy(), "size": size })),
    )
        .into_response()
}
/// GET /api/files/download?path=<file> — download a single file inside HOME.
pub async fn api_download_file(Query(q): Query<DownloadQuery>) -> Response {
    let (home, target) = match resolve_inside_home(Some(&q.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let _ = home;

    let Ok(meta) = std::fs::metadata(&target) else {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", target.display()),
        )
            .into_response();
    };
    if !meta.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            "only files can be downloaded".to_string(),
        )
            .into_response();
    }
    // 100 MB cap — the UI is for quick grabs, not full backups.
    const MAX_BYTES: u64 = 100 * 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("file too large ({} bytes, max 100 MB)", meta.len()),
        )
            .into_response();
    }

    let Ok(bytes) = std::fs::read(&target) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read file".to_string(),
        )
            .into_response();
    };
    let mime = mime_guess::from_path(&target).first_or_octet_stream();
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let disposition = if inline_requested(&q) {
        format!("inline; filename=\"{name}\"")
    } else {
        format!("attachment; filename=\"{name}\"")
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .body(Body::from(bytes))
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot build response".to_string(),
            )
                .into_response()
        })
}

/// GET /api/files/stat?path=<file|dir> — metadata + unix permissions.
#[derive(Deserialize)]
pub struct StatQuery {
    pub path: String,
}

#[derive(Serialize)]
pub struct StatResponse {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    #[cfg(unix)]
    pub uid: u32,
    #[cfg(unix)]
    pub gid: u32,
    /// Permission bits (0..=0o7777) — `mode & 0o7777`.
    pub mode: u32,
    /// Zero-padded octal string, e.g. `"755"`.
    pub mode_octal: String,
    pub readonly: bool,
}

#[cfg(unix)]
fn unix_ids(meta: &std::fs::Metadata) -> (u32, u32) {
    use std::os::unix::fs::MetadataExt;
    (meta.uid(), meta.gid())
}

pub async fn api_stat_file(Query(q): Query<StatQuery>) -> Response {
    let (_, target) = match resolve_inside_home(Some(&q.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                format!("not found: {}", target.display()),
            )
                .into_response();
        }
    };
    let is_dir = meta.is_dir();
    let size = if is_dir { 0 } else { meta.len() };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    #[cfg(unix)]
    let (mode, uid, gid) = {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o7777;
        let (uid, gid) = unix_ids(&meta);
        (mode, uid, gid)
    };
    #[cfg(not(unix))]
    let (mode, uid, gid) = (if meta.permissions().readonly() {
        0o444
    } else {
        0o644
    }, 0u32, 0u32);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| target.to_string_lossy().to_string());
    let res = StatResponse {
        path: target.to_string_lossy().to_string(),
        name,
        is_dir,
        size,
        modified,
        #[cfg(unix)]
        uid,
        #[cfg(unix)]
        gid,
        mode,
        mode_octal: format!("{mode:03o}"),
        readonly: meta.permissions().readonly(),
    };
    // uid/gid are unix-only fields; keep the struct honest on all targets.
    (StatusCode::OK, Json(res)).into_response()
}

/// GET /api/files/search?root=<dir>&q=<name-fragment>&max=<n> — recursive
/// filename search under `root` (default HOME). Case-insensitive substring
/// match on the file name only. Bounded: max depth 12, 20k visits, `max`
/// results (default 100, cap 500); `truncated` says more may exist.
#[derive(Deserialize)]
pub struct SearchQuery {
    pub root: Option<String>,
    pub q: String,
    pub max: Option<usize>,
}

#[derive(Serialize, Clone)]
pub struct SearchEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub root: String,
    pub query: String,
    pub truncated: bool,
    pub count: usize,
    pub entries: Vec<SearchEntry>,
}

const SEARCH_MAX_DEPTH: usize = 12;
const SEARCH_MAX_VISITS: usize = 20_000;

fn run_search(root: &std::path::Path, query: &str, max: usize) -> (Vec<SearchEntry>, bool) {
    let needle = query.to_lowercase();
    let mut out: Vec<SearchEntry> = Vec::new();
    let mut truncated = false;
    let mut visits: usize = 0;
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= max {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            visits += 1;
            if visits > SEARCH_MAX_VISITS {
                truncated = true;
                break;
            }
            if out.len() >= max {
                truncated = true;
                break;
            }
            let p = item.path();
            let Ok(meta) = item.metadata() else {
                continue;
            };
            let is_dir = meta.is_dir();
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.to_lowercase().contains(&needle) {
                out.push(SearchEntry {
                    name,
                    path: p.to_string_lossy().to_string(),
                    is_dir,
                    size: if is_dir { 0 } else { meta.len() },
                    modified: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64),
                });
            }
            // Descend into real dirs only (never symlinks — avoids cycles).
            if is_dir && depth < SEARCH_MAX_DEPTH && item.file_type().map(|t| !t.is_symlink()).unwrap_or(false) {
                stack.push((p, depth + 1));
            }
        }
        if truncated {
            break;
        }
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    (out, truncated)
}

pub async fn api_search_files(Query(q): Query<SearchQuery>) -> Response {
    let query = q.q.trim().to_string();
    if query.is_empty() || query.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            "query must be 1..128 chars".to_string(),
        )
            .into_response();
    }
    if query.contains('/') || query.contains('\\') || query.contains('\0') {
        return (
            StatusCode::BAD_REQUEST,
            "query matches file names only (no slashes)".to_string(),
        )
            .into_response();
    }
    let (_, root) = match resolve_inside_home(q.root.as_deref()) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if !root.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a directory: {}", root.display()),
        )
            .into_response();
    }
    let max = q.max.unwrap_or(100).clamp(1, 500);
    let (entries, truncated) = run_search(&root, &query, max);
    let res = SearchResponse {
        root: root.to_string_lossy().to_string(),
        query,
        truncated,
        count: entries.len(),
        entries,
    };
    (StatusCode::OK, Json(res)).into_response()
}

/// Cap for generated/downloaded archives (UI is for quick grabs, not backups).
const ZIP_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Refuse to even inspect archives that would extract beyond this (zip-bomb guard).
const UNZIP_TOTAL_MAX: u64 = 1024 * 1024 * 1024;

/// `zip`/`unzip` are required on the host (same pattern as curl/wget for uploads).
fn zip_missing() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        "zip/unzip not found on host".to_string(),
    )
        .into_response()
}

/// Best-effort parse of `unzip -l` output → total uncompressed bytes.
/// Info-ZIP ends the listing with e.g. `   12345  3 files`.
fn parse_unzip_list_total(text: &str) -> Option<u64> {
    for line in text.lines().rev() {
        let low = line.to_lowercase();
        if low.contains("file") && (low.contains("files") || low.contains("1 file")) {
            let first = line.split_whitespace().next()?;
            if let Ok(n) = first.replace(',', "").parse::<u64>() {
                return Some(n);
            }
        }
    }
    None
}

/// GET /api/files/download-zip?path=<file|dir> — stream a `.zip` of one entry.
/// Refuses HOME itself (too easy to archive the world by accident).
#[derive(Deserialize)]
pub struct DownloadZipQuery {
    pub path: String,
}

pub async fn api_download_zip(Query(q): Query<DownloadZipQuery>) -> Response {
    let (home, target) = match resolve_inside_home(Some(&q.path)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if target == home {
        return (
            StatusCode::BAD_REQUEST,
            "cannot zip HOME itself (pick a subfolder)".to_string(),
        )
            .into_response();
    }
    if std::fs::symlink_metadata(&target).is_err() {
        return (
            StatusCode::NOT_FOUND,
            format!("not found: {}", target.display()),
        )
            .into_response();
    }
    let Some(parent) = target.parent().map(|p| p.to_path_buf()) else {
        return (StatusCode::BAD_REQUEST, "bad path".to_string()).into_response();
    };
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive".to_string());
    // `./` prefix keeps names starting with `-` out of option parsing.
    let arg = format!("./{base}");
    let out = match tokio::process::Command::new("zip")
        .args(["-qr", "-", "--", &arg])
        .current_dir(&parent)
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return zip_missing(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot run zip: {e}"),
            )
                .into_response();
        }
    };
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let tail = tail.trim().lines().last().unwrap_or("zip failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("zip: {}", tail.chars().take(200).collect::<String>()),
        )
            .into_response();
    }
    if out.stdout.len() as u64 > ZIP_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "archive too large (max 200 MB)".to_string(),
        )
            .into_response();
    }
    let zip_name = format!("{}.zip", base.replace('"', "_"));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{zip_name}\""),
        )
        .header(header::CONTENT_LENGTH, out.stdout.len().to_string())
        .body(Body::from(out.stdout))
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot build response".to_string(),
            )
                .into_response()
        })
}

/// POST /api/files/zip-many {"dir", "names": [...], "out"?} — zip a
/// multi-selection into one archive inside `dir` (default `selection.zip`).
#[derive(Deserialize)]
pub struct ZipManyBody {
    pub dir: String,
    pub names: Vec<String>,
    pub out: Option<String>,
}

/// Normalize the output archive name (always ends in `.zip`).
fn normalize_zip_out(raw: Option<&str>, fallback: &str) -> Result<String, String> {
    let name = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback);
    if !valid_file_name(name) {
        return Err(format!("invalid name: {name}"));
    }
    if name.len() > 255 {
        return Err("archive name too long".to_string());
    }
    if name.to_lowercase().ends_with(".zip") {
        Ok(name.to_string())
    } else {
        Ok(format!("{name}.zip"))
    }
}

pub async fn api_zip_many(Json(b): Json<ZipManyBody>) -> Response {
    let (_, dir) = match resolve_inside_home(Some(&b.dir)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    if !dir.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a folder: {}", dir.display()),
        )
            .into_response();
    }
    if b.names.is_empty() || b.names.len() > 500 {
        return (
            StatusCode::BAD_REQUEST,
            "pick 1..500 files".to_string(),
        )
            .into_response();
    }
    for n in &b.names {
        if !valid_file_name(n.trim()) {
            return (StatusCode::BAD_REQUEST, format!("invalid name: {n}")).into_response();
        }
        if !dir.join(n.trim()).exists() {
            return (
                StatusCode::NOT_FOUND,
                format!("not found: {n}"),
            )
                .into_response();
        }
    }
    let out_name = match normalize_zip_out(b.out.as_deref(), "selection.zip") {
        Ok(n) => n,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let out_path = dir.join(&out_name);
    if std::fs::symlink_metadata(&out_path).is_ok() {
        return (
            StatusCode::CONFLICT,
            format!("already exists: {}", out_path.display()),
        )
            .into_response();
    }
    let mut cmd = tokio::process::Command::new("zip");
    cmd.args(["-qr", &out_path.to_string_lossy()]);
    cmd.arg("--");
    for n in &b.names {
        // `./` prefix keeps leading-dash names out of option parsing.
        cmd.arg(format!("./{}", n.trim()));
    }
    cmd.current_dir(&dir);
    match cmd.output().await {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let _ = std::fs::remove_file(&out_path);
            let tail = String::from_utf8_lossy(&o.stderr);
            let tail = tail.trim().lines().last().unwrap_or("zip failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("zip: {}", tail.chars().take(200).collect::<String>()),
            )
                .into_response();
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return zip_missing(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot run zip: {e}"),
            )
                .into_response();
        }
    }
    let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "path": out_path.to_string_lossy(), "size": size })),
    )
        .into_response()
}

/// POST /api/files/unzip {"file", "dest"?} — extract a `.zip` archive inside
/// HOME (never overwrites: `unzip -n`). `dest` defaults to the archive's folder.
#[derive(Deserialize)]
pub struct UnzipBody {
    pub file: String,
    pub dest: Option<String>,
}

pub async fn api_unzip_file(Json(b): Json<UnzipBody>) -> Response {
    let (_, file) = match resolve_inside_home(Some(&b.file)) {
        Ok(v) => v,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let meta = match std::fs::metadata(&file) {
        Ok(m) if m.is_file() => m,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "only .zip archives can be extracted".to_string(),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                format!("not found: {}", file.display()),
            )
                .into_response();
        }
    };
    let is_zip = file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return (
            StatusCode::BAD_REQUEST,
            "only .zip archives can be extracted".to_string(),
        )
            .into_response();
    }
    if meta.len() > ZIP_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "archive too large (max 200 MB)".to_string(),
        )
            .into_response();
    }
    let dest = match &b.dest {
        Some(d) => match resolve_inside_home(Some(d)) {
            Ok((_, p)) => p,
            Err((code, msg)) => return (code, msg).into_response(),
        },
        None => file.parent().map(|p| p.to_path_buf()).unwrap_or_else(home_dir),
    };
    if let Err(e) = std::fs::create_dir_all(&dest) {
        return (
            StatusCode::BAD_REQUEST,
            format!("cannot create destination: {e}"),
        )
            .into_response();
    }
    if !dest.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            format!("not a folder: {}", dest.display()),
        )
            .into_response();
    }
    // Zip-bomb guard: inspect the listing total before extracting.
    match tokio::process::Command::new("unzip")
        .args(["-l"])
        .arg(&file)
        .output()
        .await
    {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
            if let Some(total) = parse_unzip_list_total(&text)
                && total > UNZIP_TOTAL_MAX
            {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "archive extracts to over 1 GB (refused)".to_string(),
                )
                    .into_response();
            }
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return zip_missing(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot run unzip: {e}"),
            )
                .into_response();
        }
    }
    match tokio::process::Command::new("unzip")
        .args(["-n", "-q"])
        .arg(&file)
        .args(["-d"])
        .arg(&dest)
        .output()
        .await
    {
        Ok(o) if o.status.success() => (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": true, "dest": dest.to_string_lossy() })),
        )
            .into_response(),
        Ok(o) => {
            let tail = String::from_utf8_lossy(&o.stderr);
            let tail = tail.trim().lines().last().unwrap_or("unzip failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("unzip: {}", tail.chars().take(200).collect::<String>()),
            )
                .into_response()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => zip_missing(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot run unzip: {e}"),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_defaults_when_no_path() {
        let (home, dir) = resolve_inside_home(None).expect("home resolves");
        assert_eq!(home, dir);
    }

    #[test]
    fn rejects_escape_from_home() {
        let home = home_dir().to_string_lossy().to_string();
        assert!(
            resolve_inside_home(Some("/etc/passwd")).is_err(),
            "home={home}"
        );
        assert!(resolve_inside_home(Some("../../..")).is_err());
    }

    #[test]
    fn lists_home() {
        let home = home_dir().to_string_lossy().to_string();
        let entries = std::fs::read_dir(&home).expect("home readable");
        assert!(entries.count() > 0 || home == "/");
    }

    #[test]
    fn valid_names() {
        assert!(valid_file_name("notes.txt"));
        assert!(valid_file_name("my folder"));
        assert!(!valid_file_name(""));
        assert!(!valid_file_name("."));
        assert!(!valid_file_name(".."));
        assert!(!valid_file_name("a/b"));
        assert!(!valid_file_name("a\\b"));
    }

    #[test]
    fn save_stays_inside_home() {
        assert!(resolve_inside_home(Some("/etc/hostname")).is_err());
        let (home, p) =
            resolve_inside_home(Some("ks-ssh-test-save.txt")).expect("relative joins home");
        assert!(p.starts_with(&home));
    }

    #[test]
    fn upload_url_validation() {
        assert!(valid_upload_url("https://example.com/file.zip"));
        assert!(valid_upload_url("http://example.com/a/b?q=1"));
        assert!(!valid_upload_url("file:///etc/passwd"));
        assert!(!valid_upload_url("ftp://example.com/x"));
        assert!(!valid_upload_url("https://no dot"));
        assert!(!valid_upload_url("javascript:alert(1)"));
        assert_eq!(
            filename_from_url("https://example.com/a/my%20file.zip?v=2"),
            "my file.zip"
        );
        assert_eq!(filename_from_url("https://example.com/"), "download");
    }

    #[tokio::test]
    async fn upload_roundtrip_inside_home() {
        use axum::body::Bytes;
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-upload-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test dir");
        let q = UploadQuery {
            dir: dir.to_string_lossy().to_string(),
            name: "up.txt".to_string(),
        };
        let res = api_upload_file(Query(q), Bytes::from("hello upload")).await;
        // 200 OK — easiest assertion without draining the body type.
        let res = res.into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(dir.join("up.txt")).expect("written"),
            b"hello upload"
        );
        // Duplicate name is refused.
        let q2 = UploadQuery {
            dir: dir.to_string_lossy().to_string(),
            name: "up.txt".to_string(),
        };
        let res2 = api_upload_file(Query(q2), Bytes::from("again"))
            .await
            .into_response();
        assert_eq!(res2.status(), StatusCode::CONFLICT);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn mkdir_roundtrip_inside_home() {
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-mkdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (_, resolved) = resolve_inside_home(Some(&dir.to_string_lossy())).expect("inside home");
        assert!(valid_file_name(
            &resolved.file_name().expect("name").to_string_lossy()
        ));
        std::fs::create_dir_all(&resolved).expect("mkdir");
        assert!(resolved.is_dir());
        std::fs::remove_dir_all(&resolved).expect("cleanup");
        assert!(resolve_inside_home(Some("/tmp/ks-ssh-evil")).is_err());
    }

    #[tokio::test]
    async fn copy_roundtrip_inside_home() {
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).expect("test dir");
        std::fs::write(dir.join("sub").join("a.txt"), "copy me").expect("write a");
        // Copy a single file.
        let res = api_copy_file(Json(CopyBody {
            from: dir.join("sub").join("a.txt").to_string_lossy().to_string(),
            to: dir.join("b.txt").to_string_lossy().to_string(),
        }))
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(dir.join("b.txt")).expect("copied"),
            b"copy me"
        );
        // Duplicate name is refused.
        let res2 = api_copy_file(Json(CopyBody {
            from: dir.join("sub").join("a.txt").to_string_lossy().to_string(),
            to: dir.join("b.txt").to_string_lossy().to_string(),
        }))
        .await
        .into_response();
        assert_eq!(res2.status(), StatusCode::CONFLICT);
        // Recursive dir copy.
        let res3 = api_copy_file(Json(CopyBody {
            from: dir.join("sub").to_string_lossy().to_string(),
            to: dir.join("sub2").to_string_lossy().to_string(),
        }))
        .await
        .into_response();
        assert_eq!(res3.status(), StatusCode::OK);
        assert_eq!(
            std::fs::read(dir.join("sub2").join("a.txt")).expect("copied dir"),
            b"copy me"
        );
        // Copying a folder into itself is refused.
        let res4 = api_copy_file(Json(CopyBody {
            from: dir.join("sub").to_string_lossy().to_string(),
            to: dir.join("sub").join("inner").to_string_lossy().to_string(),
        }))
        .await
        .into_response();
        assert_eq!(res4.status(), StatusCode::BAD_REQUEST);
        // Escaping HOME is refused.
        let res5 = api_copy_file(Json(CopyBody {
            from: dir.join("b.txt").to_string_lossy().to_string(),
            to: "/tmp/ks-ssh-evil-copy".to_string(),
        }))
        .await
        .into_response();
        assert_eq!(res5.status(), StatusCode::FORBIDDEN);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[tokio::test]
    async fn chmod_roundtrip_inside_home() {
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-chmod-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test dir");
        let f = dir.join("c.txt");
        std::fs::write(&f, "x").expect("write");
        let res = api_chmod(Json(ChmodBody {
            path: f.to_string_lossy().to_string(),
            mode: 0o600,
        }))
        .await
        .into_response();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(res.status(), StatusCode::OK);
            assert_eq!(
                std::fs::metadata(&f).expect("meta").permissions().mode() & 0o7777,
                0o600
            );
        }
        #[cfg(not(unix))]
        {
            assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
        }
        // Bad mode is rejected everywhere.
        let res2 = api_chmod(Json(ChmodBody {
            path: f.to_string_lossy().to_string(),
            mode: 0o10000,
        }))
        .await
        .into_response();
        assert_eq!(res2.status(), StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn rename_and_delete_roundtrip_inside_home() {
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test dir");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "hi").expect("write a");
        // from-exists / to-missing / name checks live in the handler;
        // here we exercise the same fs ops on the resolved paths.
        let (home_canon, _) = resolve_inside_home(None).expect("home");
        let (_, ra) = resolve_inside_home(Some(&a.to_string_lossy())).expect("a inside home");
        let (_, rb) = resolve_inside_home(Some(&b.to_string_lossy())).expect("b inside home");
        assert!(ra.starts_with(&home_canon));
        std::fs::rename(&ra, &rb).expect("rename");
        assert!(rb.is_file());
        std::fs::remove_file(&rb).expect("delete file");
        std::fs::remove_dir_all(&dir).expect("delete dir");
        assert!(!dir.exists());
    }
}
