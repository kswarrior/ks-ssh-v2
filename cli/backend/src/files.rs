//! Files API: list + download files under the host's HOME directory.
//!
//! The CLI runs on the host, so HOME here means the host user's home
//! (`$HOME`, falling back to `$USERPROFILE` on Windows, then `/`).
//! All requested paths are canonicalized and must stay inside HOME —
//! this keeps the endpoint safe when bound with `--host 0.0.0.0`.

use axum::{
    Json,
    body::Body,
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
