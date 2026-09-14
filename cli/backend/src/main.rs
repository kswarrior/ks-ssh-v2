mod auth;
mod db;
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
    routing::{delete, get, post},
};
use clap::Parser;
use ui::Ui;

/// KS SSH — local backend + embedded web UI + WSS relay agent.
///
/// Case 9 (Identity & audit): strong auth + least-privilege RBAC + optional
/// SSO/2FA + full audit trail + session recording. See `docs/vs.md` case 9.
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
    /// This is the main account (admin) — its password confirms user edits/deletes.
    /// Must be used together with `--pass`. Omit both for open access.
    #[arg(long, alias = "username")]
    user: Option<String>,
    /// Password that must log in to use the web UI (shows a login page).
    /// Must be used together with `--user`. Omit both for open access.
    /// Min 12 chars is enforced for Users-page accounts; a short `--pass`
    /// still works (backward compat) with a startup warning.
    #[arg(long, alias = "password")]
    pass: Option<String>,
    /// Skip the local web UI (no open port at all).
    #[arg(long)]
    no_serve: bool,
    /// SQLite file for terminal session history (`./ks-ssh.db` by default).
    /// Also stores the audit log + session recordings. Shells are shared on
    /// purpose — any visitor can reattach to them.
    /// Empty string disables persistence (audit falls back to memory).
    #[arg(long, default_value = "./ks-ssh.db")]
    db: String,
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
    // -- Case 9: SSO (optional, behind flags) -------------------------------
    /// OIDC issuer URL (e.g. https://accounts.google.com). Enables SSO login
    /// (`Login` → SSO button, `GET /api/auth/oidc/login`) when set together
    /// with `--oidc-client-id`. Auto-provisions as viewer by default.
    #[arg(long)]
    oidc_issuer: Option<String>,
    /// OIDC client ID for this backend (public identifier, safe to log).
    #[arg(long)]
    oidc_client_id: Option<String>,
    /// OIDC client secret (confidential clients only). Never logged.
    #[arg(long)]
    oidc_client_secret: Option<String>,
    /// Only allow SSO emails at this domain (e.g. example.com).
    /// Omit to allow any domain from the issuer.
    #[arg(long)]
    oidc_allow_domain: Option<String>,
    // -- Case 9: audit + recording retention --------------------------------
    /// Days to keep audit rows (`--audit-retain-days`, default 90, 0 = forever).
    #[arg(long, default_value_t = 90)]
    audit_retain_days: u64,
    /// Per-session recording cap in MB (`--record-max-mb`, default 10).
    #[arg(long, default_value_t = 10)]
    record_max_mb: u64,
    /// Force session recording ON (default: on when auth is on).
    #[arg(long, conflicts_with = "no_record")]
    record: bool,
    /// Disable session recording (no input/output frames stored).
    #[arg(long)]
    no_record: bool,
    // -- Case 9: relay identity ----------------------------------------------
    /// Require a one-time viewer PIN for the relay share link (closes the
    /// bearer-open bypass honestly). The agent prints the PIN once; authed
    /// local users can mint fresh PINs via `POST /api/relay/pin`.
    /// Default (off) stays bearer-open. Never put the PIN or `k` in query/logs.
    #[arg(long)]
    relay_auth: bool,
}

async fn api_hello() -> &'static str {
    "KS SSH — hello world"
}

async fn serve_ui(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file = if path.is_empty() { "index.html" } else { path };
    // Hashed Vite output under assets/ is immutable; everything else
    // (index.html, SPA fallback, icons) must never be cached — otherwise a
    // refresh can keep serving a stale bundle whose old asset hashes fall
    // back to HTML and the app sticks on a loading screen forever.
    let immutable = file.starts_with("assets/");
    match Ui::get(file).or_else(|| Ui::get("index.html")) {
        Some(content) => {
            let mime = mime_guess::from_path(file).first_or_octet_stream();
            let cache = if immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-store"
            };
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref()),
                    (header::CACHE_CONTROL, cache),
                ],
                content.data,
            )
                .into_response()
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

async fn serve(
    host: String,
    port: u16,
    auth: Option<Arc<AuthState>>,
    oidc: Option<Arc<auth::OidcState>>,
    relay_pin: Option<Arc<auth::RelayPinState>>,
) {
    let state = AppState {
        auth: auth.clone(),
        oidc: oidc.clone(),
        relay_pin: relay_pin.clone(),
    };

    // Public: health ping + login flow + recording consent flag + OIDC.
    // (Needed to show the login page / consent banner before auth.)
    let public = Router::new()
        .route("/api/hello", get(api_hello))
        .route("/api/record/status", get(shell::api_record_status))
        .route("/api/auth/status", get(auth::api_status))
        .route("/api/auth/login", post(auth::api_login))
        .route("/api/auth/logout", post(auth::api_logout))
        .route("/api/auth/oidc/login", get(auth::api_oidc_login))
        .route("/api/auth/oidc/callback", get(auth::api_oidc_callback))
        .with_state(state.clone());

    // Protected: everything that touches the host, plus identity/audit.
    // With auth enabled these require a login session + RBAC
    // (`require_auth` → 401/403 + audit); without auth they stay open
    // (previous behaviour) and the identity endpoints report 404.
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
        // Identity: self-service + TOTP.
        .route("/api/auth/me", get(auth::api_me))
        .route(
            "/api/auth/change-password",
            post(auth::api_change_password_json),
        )
        .route("/api/auth/totp/enroll", post(auth::api_totp_enroll))
        .route("/api/auth/totp/verify", post(auth::api_totp_verify))
        .route("/api/auth/totp/disable", post(auth::api_totp_disable))
        .route("/api/auth/sessions/mine", get(auth::api_my_sessions))
        // Identity: admin user management.
        .route("/api/auth/users", get(auth::api_list_users).post(auth::api_create_user))
        .route(
            "/api/auth/users/{username}",
            axum::routing::put(auth::api_update_user).delete(auth::api_delete_user),
        )
        .route(
            "/api/auth/users/{username}/unlock",
            post(auth::api_unlock_user),
        )
        .route(
            "/api/auth/users/{username}/revoke-sessions",
            post(auth::api_revoke_user_sessions),
        )
        // Audit (admin only).
        .route("/api/audit", get(auth::api_list_audit))
        // Relay viewer PIN (operator+ mint, any-authed status).
        .route("/api/relay/pin/status", get(auth::api_relay_pin_status))
        .route("/api/relay/pin", post(auth::api_relay_pin_mint))
        // Shell + recordings.
        .route("/v1/shell", get(shell::ws_handler))
        .route("/api/terms", get(shell::api_list_terms))
        .route(
            "/api/terms/{id}/recording",
            get(shell::api_get_recording_range).delete(shell::api_delete_recording),
        )
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
    shell::spawn_persister();
    axum::serve(listener, app.into_make_service())
        .await
        .expect("serve");
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    println!("KS SSH — hello world");

    // Retention flags (audit + recordings) apply to the shared SQLite DB.
    db::set_audit_retain_days(cli.audit_retain_days);
    db::set_record_max_mb(cli.record_max_mb.max(1));

    // Optional login gate: --user + --pass together show a login page and
    // enable Users/RBAC/audit/recording. Omit both for open access.
    let auth: Option<Arc<AuthState>> = match (cli.user, cli.pass) {
        (Some(u), Some(p)) => {
            let u = u.trim().to_string();
            if u.is_empty() || p.is_empty() {
                eprintln!("--user/--pass must both be non-empty");
                std::process::exit(2);
            }
            if p.len() < auth::MIN_PASSWORD_LEN {
                eprintln!(
                    "warning: --pass is shorter than {} chars — consider a longer main password (Users-page accounts require {}+)",
                    auth::MIN_PASSWORD_LEN,
                    auth::MIN_PASSWORD_LEN
                );
            }
            let users_file = auth::default_users_file();
            let state = AuthState::new_with_file(&u, &p, users_file.clone());
            println!(
                "Auth: ON (main user '{u}' = admin) — login required for the web UI ({} extra user(s), stored in {}).",
                state.extra_user_count(),
                users_file.display()
            );
            println!(
                "RBAC: admin/operator/viewer enforced per route; audit ON (retain {}d); recording {}.",
                cli.audit_retain_days,
                if cli.no_record { "OFF (--no-record)" } else { "ON" }
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

    // Session recording: default ON when auth is on (consent banner in UI),
    // `--record` forces on, `--no-record` forces off.
    let recording_on = if cli.no_record {
        false
    } else if cli.record {
        true
    } else {
        auth.is_some()
    };
    shell::set_recording_enabled(recording_on);
    println!(
        "Recording: {} (cap {} MB/session{})",
        if recording_on { "ON" } else { "OFF" },
        cli.record_max_mb.max(1),
        if recording_on {
            " — Terminal page shows a consent banner"
        } else {
            ""
        }
    );

    // OIDC SSO (optional, behind flags). Never logs secrets.
    let oidc: Option<Arc<auth::OidcState>> =
        match (cli.oidc_issuer.clone(), cli.oidc_client_id.clone()) {
            (Some(iss), Some(cid)) => {
                let iss = iss.trim().to_string();
                let cid = cid.trim().to_string();
                if iss.is_empty() || cid.is_empty() {
                    eprintln!("--oidc-issuer/--oidc-client-id must both be non-empty");
                    std::process::exit(2);
                }
                if auth.is_none() {
                    eprintln!("warning: OIDC without --user/--pass still mints local sessions (auth gate stays open)");
                }
                println!(
                    "SSO: ON (issuer {}, client {}, allow-domain {})",
                    iss,
                    cid,
                    cli.oidc_allow_domain.as_deref().unwrap_or("(any)")
                );
                Some(Arc::new(auth::OidcState::new(
                    iss,
                    cid,
                    cli.oidc_client_secret.clone(),
                    cli.oidc_allow_domain.clone(),
                )))
            }
            (None, None) => None,
            _ => {
                eprintln!("--oidc-issuer and --oidc-client-id must be used together (or omit both)");
                std::process::exit(2);
            }
        };

    // Relay viewer PIN (`--relay-auth` closes the bearer-open bypass honestly).
    let relay_pin: Option<Arc<auth::RelayPinState>> = if cli.relay_auth {
        let st = Arc::new(auth::RelayPinState::new());
        let pin = st.mint();
        println!("Relay auth: ON — viewer PIN required for relay data bridge.");
        println!("Viewer PIN (one-time — share out-of-band, never in query/logs): {pin}");
        Some(st)
    } else {
        None
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

    // Terminal history DB — shells are shared on purpose, so any visitor
    // can reattach to them (same gate as the UI: login when --user/--pass).
    // Pure `--no-serve` agents serve nothing locally, so they skip it.
    if !cli.no_serve {
        let raw = cli.db.trim().to_string();
        if raw.is_empty() {
            println!("Terminal history: OFF (--db empty)");
        } else {
            let path = std::path::PathBuf::from(&raw);
            let loaded = db::init(Some(&path));
            if db::enabled() {
                println!(
                    "Terminal history: {} session(s) in {} (--db to move it)",
                    loaded,
                    path.display()
                );
                let restored = shell::load_persisted().await;
                if restored > 0 {
                    println!("Terminal history: {restored} session(s) restored for reattach");
                }
            }
        }
    }

    // Relay agent PIN handoff: the agent enforces the viewer PIN on its data
    // bridge when `--relay-auth` is set (see `relay::run_agent`).
    let relay_pin_for_agent = relay_pin.clone();
    match (cli.no_serve, token) {
        // Pure agent: no open port, only outbound WSS.
        (true, Some(t)) => {
            relay::run_agent(
                &relay_ws_base(&cli.relay),
                &t,
                !cli.no_ui,
                e2e_key,
                relay_pin_for_agent,
            )
            .await
        }
        (true, None) => {
            eprintln!("--no-serve needs --token (try --token= for a random one)");
            std::process::exit(2);
        }
        // Local UI plus relay agent alongside.
        (false, Some(t)) => {
            if auth.is_some() && relay_pin.is_none() {
                eprintln!("note: --user/--pass protects the local UI only; the relay share link stays bearer-open (restart with --relay-auth for a viewer PIN)");
            }
            let ws_base = relay_ws_base(&cli.relay);
            let push_ui = !cli.no_ui;
            tokio::spawn(async move {
                relay::run_agent(&ws_base, &t, push_ui, e2e_key, relay_pin_for_agent).await
            });
            serve(cli.host, cli.port, auth, oidc, relay_pin).await;
        }
        // Local UI only (previous behaviour).
        (false, None) => serve(cli.host, cli.port, auth, oidc, relay_pin).await,
    }
}
