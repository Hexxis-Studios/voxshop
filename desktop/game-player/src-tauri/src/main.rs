#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    error::Error,
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tauri::{
    http::{Method, Response, StatusCode},
    webview::WebviewWindowBuilder,
    WebviewUrl,
};

const TRAILER_MAGIC: &[u8; 8] = b"VOXGAME1";
const TRAILER_BYTES: u64 = 56;
const MAX_GAME_BYTES: u64 = 128 * 1024 * 1024;
const ORIGIN_IDENTITY_BYTES: usize = 16;
const PROJECT_MARKER: &str = "<script id=\"voxshop-project\" type=\"application/json\">";
const WORKER_MARKER: &str = "<script id=\"voxshop-workers\" type=\"application/json\">";
const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_digest(digest: &[u8]) -> String {
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

struct GamePayload {
    html: Arc<Vec<u8>>,
    scheme: String,
    title: String,
}

fn embedded_json<'a>(html: &'a str, marker: &str) -> Result<&'a str, Box<dyn Error>> {
    html.split_once(marker)
        .and_then(|(_, content)| content.split_once("</script>"))
        .map(|(json, _)| json)
        .ok_or_else(|| format!("The game export is missing {marker}").into())
}

fn load_game_payload() -> Result<Option<GamePayload>, Box<dyn Error>> {
    let executable = std::env::current_exe()?;
    let mut file = File::open(&executable)?;
    let file_len = file.metadata()?.len();
    if file_len < TRAILER_BYTES {
        return Ok(None);
    }

    file.seek(SeekFrom::End(-(TRAILER_BYTES as i64)))?;
    let mut trailer = [0u8; TRAILER_BYTES as usize];
    file.read_exact(&mut trailer)?;
    if &trailer[..8] != TRAILER_MAGIC {
        return Ok(None);
    }

    let version = u32::from_le_bytes(trailer[8..12].try_into()?);
    let reserved = u32::from_le_bytes(trailer[12..16].try_into()?);
    let payload_len = u64::from_le_bytes(trailer[16..24].try_into()?);
    if version != 1 || reserved != 0 {
        return Err("This VoxShop game export uses an unsupported player format.".into());
    }
    if payload_len == 0 || payload_len > MAX_GAME_BYTES || payload_len + TRAILER_BYTES >= file_len {
        return Err("This VoxShop game export has an invalid or oversized payload.".into());
    }

    let payload_start = file_len - TRAILER_BYTES - payload_len;
    if payload_start < 1024 {
        return Err("This VoxShop game export has no valid player executable.".into());
    }
    file.seek(SeekFrom::Start(payload_start))?;
    let mut html = vec![0u8; payload_len as usize];
    file.read_exact(&mut html)?;
    let digest = Sha256::digest(&html);
    if digest.as_slice() != &trailer[24..56] {
        return Err("The embedded VoxShop game payload failed its integrity check.".into());
    }

    let html_text = std::str::from_utf8(&html)?;
    if !(html_text.starts_with("<!doctype html") || html_text.starts_with("<!DOCTYPE html"))
        || !html_text.contains(PROJECT_MARKER)
        || !html_text.contains(WORKER_MARKER)
        || !html_text.contains("<script>")
        || !html_text.contains("</body>")
    {
        return Err("The embedded payload is not a supported standalone VoxShop game.".into());
    }

    let project: serde_json::Value =
        serde_json::from_str(embedded_json(html_text, PROJECT_MARKER)?)?;
    let name = project
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or("The embedded VoxShop game has no title.")?;
    if project
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_none()
        || project
            .get("activeSceneId")
            .and_then(serde_json::Value::as_str)
            .is_none()
    {
        return Err("The embedded VoxShop game has invalid project identity.".into());
    }

    let title: String = name
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(120)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = if title.is_empty() {
        "VoxShop game".to_owned()
    } else {
        title
    };
    let scheme = format!("vxp-{}", hex_digest(&digest[..ORIGIN_IDENTITY_BYTES]));

    Ok(Some(GamePayload {
        html: Arc::new(html),
        scheme,
        title,
    }))
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .body(b"Not found".to_vec())
        .expect("valid not-found response")
}

fn run_fallback_player() {
    tauri::Builder::default()
        .setup(|app| {
            if app.config().app.windows.is_empty() {
                let url = "tauri://localhost/index.html".parse()?;
                WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
                    .title("VoxShop Game Player")
                    .inner_size(960.0, 640.0)
                    .build()?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the VoxShop game player")
        .run(|_, _| {});
}

fn run_game(payload: GamePayload) {
    let GamePayload {
        html,
        scheme,
        title,
    } = payload;
    let protocol_html = Arc::clone(&html);
    let window_url = format!("{scheme}://localhost/index.html");
    tauri::Builder::default()
        .register_uri_scheme_protocol(scheme, move |_context, request| {
            let uri = request.uri();
            if request.method() != &Method::GET
                || uri.query().is_some()
                || !matches!(uri.path(), "/" | "/index.html")
            {
                return not_found();
            }
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .body(protocol_html.as_ref().clone())
                .expect("valid game response")
        })
        .setup(move |app| {
            let url = window_url.parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
                .title(title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the VoxShop game player")
        .run(|_, _| {});
}

fn main() {
    match load_game_payload() {
        Ok(Some(payload)) => run_game(payload),
        Ok(None) => run_fallback_player(),
        Err(error) => {
            eprintln!("Could not open VoxShop game: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{hex_digest, ORIGIN_IDENTITY_BYTES};

    #[test]
    fn custom_scheme_uses_a_dns_safe_128_bit_identity() {
        let digest = [0xab; 32];
        let scheme = format!("vxp-{}", hex_digest(&digest[..ORIGIN_IDENTITY_BYTES]));
        assert_eq!(scheme, format!("vxp-{}", "ab".repeat(16)));
        assert!(scheme.len() <= 63);
        assert_eq!(
            hex_digest(&digest).len(),
            64,
            "the full digest remains available for trailer validation"
        );
    }
}
