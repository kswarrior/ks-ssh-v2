//! Stylish startup panel: one clean box with LINK, Token, E2E key (or
//! E2E OFF), URL:PORT and the remaining state (login, viewer PIN, relay).
//!
//! The E2E secret `k` is display-only here (the one-time share links below);
//! it is never logged elsewhere, never stored, never put in query strings.

use std::io::IsTerminal;

/// Everything the startup panel shows. `None` rows are omitted, so the same
/// renderer covers local-only (`--port`), pure agent (`--no-serve --token=`)
/// and combined (`--token=` + serve) modes.
pub struct StartupBanner {
    /// Public local UI, e.g. `http://127.0.0.1:8080` (`None` with `--no-serve`).
    pub local_url: Option<String>,
    /// Internal loopback the relay proxies to (pure-agent ephemeral port).
    pub loopback: Option<String>,
    /// Relay https base, e.g. `https://ks-ssh-v2.kswarriorpro.workers.dev`.
    pub relay_http: Option<String>,
    /// Room token (routing only, safe to display).
    pub token: Option<String>,
    /// E2E on/off; when on, `e2e_key` holds the one-time display copy.
    pub e2e_on: bool,
    pub e2e_key: Option<String>,
    pub e2e_fp: Option<String>,
    /// One-time viewer PIN (`--relay-auth`), shared out-of-band.
    pub viewer_pin: Option<String>,
    /// Local login gate (`--user/--pass`).
    pub auth_on: bool,
    /// Whether relay data is PIN-gated (`--relay-auth`).
    pub relay_auth_on: bool,
    /// False with `--no-ui` (no fullscreen bundle push).
    pub push_ui: bool,
}

const LABEL_W: usize = 7;
const C_BOLD: &str = "\x1b[1m";
const C_DIM: &str = "\x1b[2m";
const C_CYAN: &str = "\x1b[36m";
const C_GREEN: &str = "\x1b[32m";
const C_RED: &str = "\x1b[31m";
const C_YELLOW: &str = "\x1b[33m";
const R: &str = "\x1b[0m";

fn colors_enabled() -> bool {
    std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal()
}

fn visible_len(s: &str) -> usize {
    s.chars().count()
}

struct Row {
    label: Option<&'static str>,
    value: String,
    /// ANSI code wrapping the value (`""` = none).
    style: &'static str,
}

fn collect_rows(b: &StartupBanner) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    if let Some(url) = b.local_url.as_deref() {
        rows.push(Row {
            label: Some("URL"),
            value: url.to_string(),
            style: C_BOLD,
        });
    } else if b.token.is_some() {
        rows.push(Row {
            label: Some("Serve"),
            value: "OFF (--no-serve, no open port)".to_string(),
            style: "",
        });
    }
    if let Some(lb) = b.loopback.as_deref() {
        // Pure-agent internal target (never exposed, shown for debugging).
        if b.local_url.is_none() {
            rows.push(Row {
                label: Some("Local"),
                value: format!("{lb} (loopback only)"),
                style: "",
            });
        }
    }
    if let Some(t) = b.token.as_deref() {
        rows.push(Row {
            label: Some("Token"),
            value: t.to_string(),
            style: C_BOLD,
        });
    }
    if b.token.is_some() {
        if b.e2e_on {
            rows.push(Row {
                label: Some("E2E"),
                value: "ON (AES-256-GCM)".to_string(),
                style: C_GREEN,
            });
            if let Some(k) = b.e2e_key.as_deref() {
                rows.push(Row {
                    label: Some("E2E key"),
                    value: k.to_string(),
                    style: C_YELLOW,
                });
            }
            if let Some(fp) = b.e2e_fp.as_deref() {
                rows.push(Row {
                    label: Some("Finger"),
                    value: format!("{fp} (verify in viewer, TOFU)"),
                    style: "",
                });
            }
        } else {
            rows.push(Row {
                label: Some("E2E"),
                value: "OFF (relay-visible)".to_string(),
                style: C_RED,
            });
        }
    }
    // Share links (contain the secret when E2E is on — send directly).
    if let (Some(http), Some(t)) = (b.relay_http.as_deref(), b.token.as_deref()) {
        let base = http.trim_end_matches('/');
        if b.e2e_on {
            if let Some(k) = b.e2e_key.as_deref() {
                rows.push(Row {
                    label: Some("Link"),
                    value: format!("{base}/v/{t}#k={k}"),
                    style: C_YELLOW,
                });
                rows.push(Row {
                    label: Some("Link"),
                    value: format!("{base}/#/session/{t}#k={k}"),
                    style: "",
                });
            }
        } else {
            rows.push(Row {
                label: Some("Link"),
                value: format!("{base}/v/{t}"),
                style: "",
            });
        }
        if !b.push_ui {
            rows.push(Row {
                label: Some("UI"),
                value: "--no-ui (relay-only, no fullscreen bundle)".to_string(),
                style: "",
            });
        }
    }
    if let Some(pin) = b.viewer_pin.as_deref() {
        rows.push(Row {
            label: Some("PIN"),
            value: format!("{pin} (one-time, inside E2E only)"),
            style: C_YELLOW,
        });
    }
    rows.push(Row {
        label: Some("Login"),
        value: if b.auth_on {
            "ON (login required)".to_string()
        } else {
            "OFF (open access)".to_string()
        },
        style: "",
    });
    if b.relay_auth_on {
        rows.push(Row {
            label: Some("Gating"),
            value: "PIN required before relay data flows".to_string(),
            style: "",
        });
    }
    rows
}

fn hint_row(b: &StartupBanner) -> String {
    if b.token.is_some() {
        "Enter the Token in the CF SSH page - keep the Link secret".to_string()
    } else {
        "Run with --token= to share over relay (no open port needed)".to_string()
    }
}

/// Render the panel. `color` wraps labels/values in ANSI (zero-width); width
/// math always uses visible lengths so the box stays aligned either way.
pub fn render(b: &StartupBanner, color: bool) -> String {
    let rows = collect_rows(b);
    let hint = hint_row(b);
    let title = "KS SSH - ready";
    let mut inner = visible_len(title);
    for r in &rows {
        let content_len = match r.label {
            Some(_) => LABEL_W + 1 + visible_len(&r.value),
            None => visible_len(&r.value),
        };
        inner = inner.max(content_len);
    }
    inner = inner.max(visible_len(&hint));
    inner = inner.max(24);

    let mut out = String::new();
    let border = |s: &mut String, l: char, fill: char, rr: char| {
        s.push(l);
        for _ in 0..inner + 2 {
            s.push(fill);
        }
        s.push(rr);
        s.push('\n');
    };
    if color {
        out.push_str(C_DIM);
        out.push_str(C_CYAN);
    }
    // Top border (colored separately so width math stays on content only).
    let mut top = String::new();
    border(&mut top, '╭', '─', '╮');
    out.push_str(&top);
    if color {
        out.push_str(R);
    }

    let mut line = |label: Option<&str>, value: &str, style: &str| {
        let content_pad = match label {
            Some(_) => inner - (LABEL_W + 1 + visible_len(value)),
            None => inner - visible_len(value),
        };
        if color {
            out.push_str(C_DIM);
            out.push_str(C_CYAN);
        }
        out.push_str("│ ");
        if color {
            out.push_str(R);
        }
        if let Some(l) = label {
            if color {
                out.push_str(C_CYAN);
            }
            out.push_str(l);
            for _ in visible_len(l)..LABEL_W {
                out.push(' ');
            }
            if color {
                out.push_str(R);
            }
            out.push(' ');
        }
        if color && !style.is_empty() {
            out.push_str(style);
        }
        out.push_str(value);
        if color && !style.is_empty() {
            out.push_str(R);
        }
        for _ in 0..content_pad {
            out.push(' ');
        }
        if color {
            out.push_str(C_DIM);
            out.push_str(C_CYAN);
        }
        out.push_str(" │\n");
        if color {
            out.push_str(R);
        }
    };

    if color {
        line(Some(""), title, &format!("{C_BOLD}{C_CYAN}"));
    } else {
        // Plain title row keeps the label column for alignment.
        line(Some(""), title, "");
    }
    for r in &rows {
        line(r.label, &r.value, if color { r.style } else { "" });
    }
    if color {
        line(None, &hint, C_DIM);
    } else {
        line(None, &hint, "");
    }

    if color {
        out.push_str(C_DIM);
        out.push_str(C_CYAN);
    }
    let mut bot = String::new();
    border(&mut bot, '╰', '─', '╯');
    out.push_str(&bot);
    if color {
        out.push_str(R);
    }
    out
}

/// Print the panel to stdout (colors when on a TTY without `NO_COLOR`).
pub fn print(b: &StartupBanner) {
    print!("{}", render(b, colors_enabled()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay_on() -> StartupBanner {
        StartupBanner {
            local_url: Some("http://127.0.0.1:8080".to_string()),
            loopback: None,
            relay_http: Some("https://relay.example".to_string()),
            token: Some("ABCDE1234".to_string()),
            e2e_on: true,
            e2e_key: Some("testkey-testkey-testkey-testkey-testkey12".to_string()),
            e2e_fp: Some("0123456789abcdef".to_string()),
            viewer_pin: None,
            auth_on: false,
            relay_auth_on: false,
            push_ui: true,
        }
    }

    fn widths_equal(s: &str) -> bool {
        let w: Vec<usize> = s.lines().map(|l| visible_len(l)).collect();
        w.iter().all(|&x| x == w[0])
    }

    #[test]
    fn panel_shows_link_token_key_url() {
        let s = render(&relay_on(), false);
        assert!(s.contains("http://127.0.0.1:8080"), "URL:PORT row");
        assert!(s.contains("ABCDE1234"), "token row");
        assert!(s.contains("testkey-testkey"), "E2E key row");
        assert!(
            s.contains("https://relay.example/v/ABCDE1234#k=testkey"),
            "share link row"
        );
        assert!(s.contains("0123456789abcdef"), "fingerprint row");
        assert!(widths_equal(&s), "box stays aligned");
    }

    #[test]
    fn e2e_off_shows_off_and_no_secret() {
        let mut b = relay_on();
        b.e2e_on = false;
        b.e2e_key = None;
        b.e2e_fp = None;
        let s = render(&b, false);
        assert!(s.contains("E2E     OFF"), "E2E OFF row");
        assert!(!s.contains("#k="), "no secret in links when off");
        assert!(widths_equal(&s), "box stays aligned");
    }

    #[test]
    fn local_only_has_url_no_token() {
        let b = StartupBanner {
            local_url: Some("http://127.0.0.1:8080".to_string()),
            loopback: None,
            relay_http: None,
            token: None,
            e2e_on: false,
            e2e_key: None,
            e2e_fp: None,
            viewer_pin: None,
            auth_on: false,
            relay_auth_on: false,
            push_ui: true,
        };
        let s = render(&b, false);
        assert!(s.contains("http://127.0.0.1:8080"), "URL row");
        assert!(!s.contains("Token"), "no token row without relay");
        assert!(s.contains("--token="), "hint mentions relay");
        assert!(widths_equal(&s), "box stays aligned");
    }

    #[test]
    fn pin_and_login_rows_render() {
        let mut b = relay_on();
        b.viewer_pin = Some("123456".to_string());
        b.auth_on = true;
        b.relay_auth_on = true;
        let s = render(&b, false);
        assert!(s.contains("123456"), "PIN row");
        assert!(s.contains("Login   ON"), "login row");
        assert!(s.contains("Gating"), "gating row");
    }
}
