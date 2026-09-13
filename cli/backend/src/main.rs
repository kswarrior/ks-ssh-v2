mod files;
mod host;
mod ports;
mod relay;
mod shell;
mod ui;

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

async fn serve(host: String, port: u16) {
    let app = Router::new()
        .route("/api/hello", get(api_hello))
        .route(
            "/api/files",
            get(files::api_list_files).delete(files::api_delete_file),
        )
        .route("/api/files/rename", post(files::api_rename_file))
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
        .route("/v1/shell", get(shell::ws_handler).delete(shell::api_kill_session))
        .fallback(serve_ui);

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

    match (cli.no_serve, token) {
        // Pure agent: no open port, only outbound WSS.
        (true, Some(t)) => relay::run_agent(&relay_ws_base(&cli.relay), &t, !cli.no_ui).await,
        (true, None) => {
            eprintln!("--no-serve needs --token (try --token= for a random one)");
            std::process::exit(2);
        }
        // Local UI plus relay agent alongside.
        (false, Some(t)) => {
            let ws_base = relay_ws_base(&cli.relay);
            let push_ui = !cli.no_ui;
            tokio::spawn(async move { relay::run_agent(&ws_base, &t, push_ui).await });
            serve(cli.host, cli.port).await;
        }
        // Local UI only (previous behaviour).
        (false, None) => serve(cli.host, cli.port).await,
    }
}
