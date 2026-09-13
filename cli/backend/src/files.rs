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
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.trim().is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from("/")
}

/// Lexically normalize a path (resolve `.`/`..` without touching the FS).
fn normalize(path: &PathBuf) -> PathBuf {
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
            if pb.is_absolute() {
                pb
            } else {
                home.join(pb)
            }
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

fn canonicalize_lossy(p: &PathBuf) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| normalize(p))
}

fn parent_of(home: &PathBuf, dir: &PathBuf) -> Option<String> {
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
    FileEntry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
        path: path.to_string_lossy().to_string(),
        is_dir,
        size,
        modified,
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
            return (StatusCode::NOT_FOUND, format!("not found: {}", dir.display()))
                .into_response()
        }
        Err(e) => return (StatusCode::BAD_REQUEST, format!("cannot read dir: {e}")).into_response(),
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
                .into_response()
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
            format!("content too large (max {} MB)", SAVE_MAX_BYTES / 1024 / 1024),
        )
            .into_response();
    }
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.is_dir() && !meta.is_symlink() {
            return (
                StatusCode::BAD_REQUEST,
                "cannot overwrite a folder".to_string(),
            )
                .into_response();
        }
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
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid name: {name}"),
        )
            .into_response();
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
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && t[8..].contains('.')
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
        return (
            StatusCode::BAD_REQUEST,
            format!("invalid name: {name}"),
        )
            .into_response();
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
                last_err = format!("{}: {}", args[0], tail.chars().take(200).collect::<String>());
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
        Json(
            serde_json::json!({ "ok": true, "path": target.to_string_lossy(), "size": size }),
        ),
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
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        )
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
        assert!(resolve_inside_home(Some("/etc/passwd")).is_err(), "home={home}");
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
    fn mkdir_roundtrip_inside_home() {
        let home = home_dir();
        let dir = home.join(format!(".ks-ssh-test-mkdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (_, resolved) =
            resolve_inside_home(Some(&dir.to_string_lossy())).expect("inside home");
        assert!(valid_file_name(
            &resolved
                .file_name()
                .expect("name")
                .to_string_lossy()
        ));
        std::fs::create_dir_all(&resolved).expect("mkdir");
        assert!(resolved.is_dir());
        std::fs::remove_dir_all(&resolved).expect("cleanup");
        assert!(resolve_inside_home(Some("/tmp/ks-ssh-evil")).is_err());
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
