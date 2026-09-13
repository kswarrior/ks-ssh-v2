//! Single-file frontend bundle: inline JS/CSS so the whole CLI UI can be
//! pushed over one WSS relay connection and opened fullscreen from CF.

use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../frontend/dist/"]
pub struct Ui;

/// Build a standalone HTML page with all local assets inlined.
/// Falls back to raw index.html when assets are missing.
pub fn build_single_file() -> anyhow::Result<String> {
    let index =
        Ui::get("index.html").ok_or_else(|| anyhow::anyhow!("frontend dist missing index.html"))?;
    let mut html = String::from_utf8_lossy(&index.data).into_owned();

    // Collect embedded asset contents.
    let mut js_inline = String::new();
    let mut css_inline = String::new();
    for name in Ui::iter() {
        let n = name.as_ref();
        if !(n.starts_with("assets/") && (n.ends_with(".js") || n.ends_with(".css"))) {
            continue;
        }
        if let Some(f) = Ui::get(n) {
            let text = String::from_utf8_lossy(&f.data).into_owned();
            if n.ends_with(".js") {
                js_inline.push_str(&format!("\n/* {n} */\n{text}"));
            } else {
                css_inline.push_str(&format!("\n/* {n} */\n{text}"));
            }
        }
    }

    // Replace <script ... src="/assets/*.js"> with inline module.
    // Vite emits exactly one module script; handle generically.
    if !js_inline.is_empty() {
        html = replace_asset_tag(
            &html,
            "script",
            &js_inline,
            "<script type=\"module\">\n",
            "\n</script>",
        );
    }
    if !css_inline.is_empty() {
        html = replace_asset_tag(&html, "link", &css_inline, "<style>\n", "\n</style>");
    }

    // Inline favicon as data URI so the bundle has zero external fetches.
    if let Some(icon) = Ui::get("favicon.svg") {
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &icon.data);
        let uri = format!("data:image/svg+xml;base64,{b64}");
        html = html.replace("/favicon.svg", &uri);
    }

    // Marker + base tag note for debugging.
    if !html.contains("ks-ssh-agent-ui") {
        html = html.replace(
            "</title>",
            "</title>\n    <!-- ks-ssh-agent-ui single-file bundle -->",
        );
    }
    Ok(html)
}

/// Replace the first external asset tag of a given kind with inline content.
/// `script` -> replaces `<script ... src=...>...</script>`; `link` -> replaces
/// `<link ... href=...stylesheet...>`.
fn replace_asset_tag(html: &str, kind: &str, inline: &str, open: &str, close: &str) -> String {
    if kind == "script" {
        // Find <script ... src="...assets..."> ... </script> and swap it.
        let mut out = String::with_capacity(html.len() + inline.len());
        let mut rest = html;
        let mut replaced = false;
        while let Some(start) = rest.find("<script") {
            let head = &rest[..start];
            let tag_rest = &rest[start..];
            let Some(tag_end) = tag_rest.find('>') else {
                out.push_str(rest);
                return out;
            };
            let tag = &tag_rest[..=tag_end];
            if !replaced && tag.contains("/assets/") {
                // Skip to matching </script>.
                let after_tag = &tag_rest[tag_end + 1..];
                if let Some(close_idx) = after_tag.find("</script>") {
                    out.push_str(head);
                    out.push_str(open);
                    out.push_str(inline);
                    out.push_str(close);
                    rest = &after_tag[close_idx + "</script>".len()..];
                    replaced = true;
                    continue;
                }
            }
            out.push_str(head);
            out.push_str(tag);
            rest = &tag_rest[tag_end + 1..];
        }
        out.push_str(rest);
        out
    } else {
        // link stylesheet -> inline <style>.
        let mut out = String::with_capacity(html.len() + inline.len());
        let mut rest = html;
        let mut replaced = false;
        while let Some(start) = rest.find("<link") {
            let head = &rest[..start];
            let tag_rest = &rest[start..];
            let Some(tag_end) = tag_rest.find('>') else {
                out.push_str(rest);
                return out;
            };
            let tag = &tag_rest[..=tag_end];
            if !replaced && tag.contains("/assets/") {
                out.push_str(head);
                out.push_str(open);
                out.push_str(inline);
                out.push_str(close);
                rest = &tag_rest[tag_end + 1..];
                replaced = true;
                continue;
            }
            out.push_str(head);
            out.push_str(tag);
            rest = &tag_rest[tag_end + 1..];
        }
        out.push_str(rest);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_file_inlines_assets() {
        let html = build_single_file().expect("build bundle");
        assert!(html.contains("ks-ssh-agent-ui"));
        // No external /assets/ references should remain.
        assert!(!html.contains("/assets/"), "assets must be inlined");
        assert!(html.contains("<script type=\"module\">"));
    }
}
