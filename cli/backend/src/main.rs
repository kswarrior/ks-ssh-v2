use axum::{
    Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use clap::Parser;
use rust_embed::RustEmbed;

/// KS SSH — local backend + embedded web UI.
#[derive(Parser)]
#[command(name = "ks-ssh", version)]
struct Cli {
    /// Port to serve the web UI on (127.0.0.1).
    #[arg(long, default_value_t = 8080)]
    port: u16,
}

#[derive(RustEmbed)]
#[folder = "../frontend/dist/"]
struct Ui;

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

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    println!("KS SSH — hello world");

    let app = Router::new()
        .route("/api/hello", get(api_hello))
        .fallback(serve_ui);

    let addr = format!("127.0.0.1:{}", cli.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind port");
    println!("KS SSH serving at http://{addr}");
    axum::serve(listener, app.into_make_service())
        .await
        .expect("serve");
}
