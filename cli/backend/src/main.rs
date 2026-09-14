mod auth;
mod e2e;
mod files;
mod host;
mod ports;
mod relay;
mod shell;
mod ui;

use std::sync::Arc;

use auth::{AppState, AuthState};
use axum::{
    Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use clap::Parser;
use ui::Ui;

/// KS SSH — local backend + embedded web UI + WSS relay agent.
#[derive(Parser)]
#[command(name = "ks-ssh", version)]
struct Cli {
    /// Interface to bind (127.0.0.1 = local only, 0.0.0.0 = all interfaces).
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// Port to serve the web UI on.
    #[arg(long, default_value_t = 8080)]
    port: u16,
    /// Username that must log in to use the web UI (shows a login page).
    /// This is the main account — its password confirms user edits/deletes.
    /// Must be used together with `--pass`. Omit both for open access.
    #[arg(long, alias = "username")]
    user: Option<String>,
    /// Password that must log in to use the web UI (shows a login page).
    /// Must be used together with `--user`. Omit both for open access.
    #[arg(long, alias = "password")]
    pass: Option<String>,
    /// Skip the local web UI (no open port at all).
    #[arg(long)]
    no_serve: bool,
    /// Relay via the Worker instead of opening a port.
    /// Give a token to reuse it, or pass `--token=` for a random one.
    #[arg(long, num_args(0..=1), require_equals(true), default_missing_value = "")]
    token: Option<String>,
    /// Relay base URL (https/wss).
    #[arg(long, default_value = "https://ks-ssh-v2.kswarriorpro.workers.dev")]
    relay: String,
    /// Skip pushing the frontend UI bundle over WSS (relay only).
    #[arg(long)]
    no_ui: bool,
    /// Disable end-to-end encryption (legacy plaintext relay, relay-visible).
    #[arg(long)]
    no_e2e: bool,
    /// E2E secret (base64url 32 bytes, from a printed share link `#k=...`).
    /// Omit to auto-generate a fresh `k` per run.
    #[arg(long)]
    e2e_key: Option<String>,
}

async fn api_hello() -> &'static str {
    "KS SSH — hello world"
}

async fn serve_ui(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = if path.is_empty() { "index.html" } else { path };
    match Ui::get(file).or_else(|| Ui::get("index.html")) {
        Some(content) => {
            let mime = mime_guess::from_path(file).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

fn relay_ws_base(relay: &str) -> String {
    let base = relay.trim_end_matches('/');
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    }
}

async fn serve(host: String, port: u16, auth: Option<Arc<AuthState>>) {
    let state = AppState { auth: auth.clone() };

    // Public: health ping + login flow (needed to show the login page).
    let public = Router::new()
        .route("/api/hello", get(api_hello))
        .route("/api/auth/status", get(auth::api_status))
        .route("/api/auth/login", post(auth::api_login))
        .route("/api/auth/logout", post(auth::api_logout))
        .with_state(state.clone());

    // Protected: everything that touches the host, plus user management.
    // With auth enabled these require a login session; without auth they
    // stay open (previous behaviour) and the user endpoints report 404.
    let protected = Router::new()
        .route(
            "/api/files",
            get(files::api_list_files).delete(files::api_delete_file),
        )
        .route("/api/files/rename", post(files::api_rename_file))
        .route("/api/files/copy", post(files::api_copy_file))
        .route("/api/files/stat", get(files::api_stat_file))
        .route("/api/files/chmod", post(files::api_chmod))
        .route("/api/files/search", get(files::api_search_files))
        .route("/api/files/download-zip", get(files::api_download_zip))
        .route("/api/files/zip-many", post(files::api_zip_many))
        .route("/api/files/unzip", post(files::api_unzip_file))
        .route("/api/files/mkdir", post(files::api_mkdir))
        .route("/api/files/upload", post(files::api_upload_file))
        .route("/api/files/upload-url", post(files::api_upload_url))
        .route("/api/files/download", get(files::api_download_file))
        .route("/api/ports", get(ports::api_list_ports))
        .route("/api/ports/kill", post(ports::api_kill_port))
        .route("/api/host", get(host::api_host_info))
        .route(
            "/api/files/content",
            get(files::api_read_content).put(files::api_save_content),
        )
        .route("/api/auth/users", get(auth::api_list_users).post(auth::api_create_user))
        .route(
            "/api/auth/users/{username}",
            axum::routing::put(auth::api_update_user).delete(auth::api_delete_user),
        )
        .route("/v1/shell", get(shell::ws_handler))
        .with_state(state);

    let app = match auth {
        Some(ref arc) => {
            let guarded = protected.route_layer(axum::middleware::from_fn_with_state(
                arc.clone(),
                auth::require_auth,
            ));
            public.merge(guarded).fallback(serve_ui)
        }
        None => public.merge(protected).fallback(serve_ui),
    };

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind port");
    println!("KS SSH serving at http://{addr}");
    shell::spawn_reaper();
    axum::serve(listener, app.into_make_service())
        .await
        .expect("serve");
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    println!("KS SSH — hello world");

    // Optional login gate: --user + --pass together show a login page and
    // enable the Settings → Users management. Omit both for open access.
    let auth: Option<Arc<AuthState>> = match (cli.user, cli.pass) {
        (Some(u), Some(p)) => {
            let u = u.trim().to_string();
            if u.is_empty() || p.is_empty() {
                eprintln!("--user/--pass must both be non-empty");
                std::process::exit(2);
            }
            let users_file = auth::default_users_file();
            let state = AuthState::new_with_file(&u, &p, users_file.clone());
            println!(
                "Auth: ON (main user '{u}') — login required for the web UI ({} extra user(s), stored in {}).",
                state.extra_user_count(),
                users_file.display()
            );
            Some(Arc::new(state))
        }
        (None, None) => {
            println!("Auth: OFF (open access — anyone who can reach the port can run commands).");
            None
        }
        _ => {
            eprintln!("--user and --pass must be used together (or omit both)");
            std::process::exit(2);
        }
    };

    let token: Option<String> = cli.token.map(|t| {
        if t.is_empty() {
            relay::new_token()
        } else {
            t.to_uppercase()
        }
    });
    if let Some(ref t) = token
        && !relay::valid_token(t)
    {
        eprintln!("bad token (want 5 letters/numbers)");
        std::process::exit(2);
    }

    // E2E key handling: `--token=` auto-generates `k` unless `--e2e-key=`
    // is given; `--no-e2e` forces legacy plaintext (escape hatch).
    if cli.no_e2e && cli.e2e_key.is_some() {
        eprintln!("--no-e2e conflicts with --e2e-key");
        std::process::exit(2);
    }
    let e2e_key: Option<e2e::E2eKey> = if cli.no_e2e {
        None
    } else if let Some(ref s) = cli.e2e_key {
        match e2e::E2eKey::from_base64url(s.trim()) {
            Ok(k) => Some(k),
            Err(e) => {
                eprintln!("bad --e2e-key: {e:#}");
                std::process::exit(2);
            }
        }
    } else if token.is_some() {
        match e2e::E2eKey::generate() {
            Ok(k) => Some(k),
            Err(e) => {
                eprintln!("rng failed: {e:#}");
                std::process::exit(2);
            }
        }
    } else {
        None
    };

    match (cli.no_serve, token) {
        // Pure agent: no open port, only outbound WSS.
        (true, Some(t)) => {
            relay::run_agent(&relay_ws_base(&cli.relay), &t, !cli.no_ui, e2e_key).await
        }
        (true, None) => {
            eprintln!("--no-serve needs --token (try --token= for a random one)");
            std::process::exit(2);
        }
        // Local UI plus relay agent alongside.
        (false, Some(t)) => {
            if auth.is_some() {
                eprintln!("note: --user/--pass protects the local UI only; the relay share link stays open to whoever holds it");
            }
            let ws_base = relay_ws_base(&cli.relay);
            let push_ui = !cli.no_ui;
            tokio::spawn(async move { relay::run_agent(&ws_base, &t, push_ui, e2e_key).await });
            serve(cli.host, cli.port, auth).await;
        }
        // Local UI only (previous behaviour).
        (false, None) => serve(cli.host, cli.port, auth).await,
    }
}
