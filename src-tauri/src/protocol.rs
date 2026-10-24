//! Asynchronous `cadence-media` URI scheme handler with RFC 9110 HTTP Range streaming and CORS.
//!
//! Serves local audio (`file/<base64url>`), extracted cover art (`art/<base64url>`), and sidecar
//! animated covers (`cover.mp4` / `cover.webm`) strictly within `MediaAllowlist` roots.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode};

use crate::allowlist::MediaAllowlist;

const MAX_OPEN_RANGE_CHUNK: u64 = 4 * 1024 * 1024; // 4 MiB chunking for open-ended `bytes=N-` audio streams

fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("m4a" | "mp4" | "m4b") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("wav") => "audio/wav",
        Some("ogg" | "oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("webm") => "video/webm",
        Some("aiff" | "aif") => "audio/aiff",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn with_cors_headers(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "Range, Content-Type")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length, Content-Type",
        )
}

fn plain_response(status: StatusCode, message: &'static str) -> Response<Vec<u8>> {
    with_cors_headers(Response::builder().status(status))
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn decode_base64url_path(encoded: &str) -> Option<String> {
    if encoded.is_empty()
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| URL_SAFE.decode(encoded))
        .ok()?;
    String::from_utf8(bytes).ok()
}

enum MediaTarget {
    File(String),
    Art(String),
}

fn parse_media_uri(uri: &tauri::http::Uri) -> Result<MediaTarget, StatusCode> {
    let host = uri.host().unwrap_or("").to_ascii_lowercase();
    let decoded_path = percent_decode_str(uri.path()).decode_utf8_lossy();
    let trimmed = decoded_path.trim_start_matches('/');

    let (kind, rest) = if host == "localhost" || host == "cadence-media.localhost" || host.is_empty()
    {
        let Some((k, r)) = trimmed.split_once('/') else {
            return Err(StatusCode::BAD_REQUEST);
        };
        (k.to_ascii_lowercase(), r.trim_start_matches('/'))
    } else {
        (host, trimmed)
    };

    if kind != "file" && kind != "art" {
        return Err(StatusCode::NOT_FOUND);
    }
    if rest.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let Some(decoded_fs_path) = decode_base64url_path(rest) else {
        return Err(StatusCode::BAD_REQUEST);
    };

    if kind == "art" {
        Ok(MediaTarget::Art(decoded_fs_path))
    } else {
        Ok(MediaTarget::File(decoded_fs_path))
    }
}

struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_range_header(header: &str, total: u64) -> Option<ByteRange> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    // Single-range spec (`start-end`, `start-`, `-suffix`).
    let (raw_start, raw_end) = spec.split_once('-')?;
    if raw_start.is_empty() && raw_end.is_empty() {
        return None;
    }

    if raw_start.is_empty() {
        let suffix: u64 = raw_end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some(ByteRange {
            start,
            end: total - 1,
        });
    }

    let start: u64 = raw_start.parse().ok()?;
    if start >= total {
        return None;
    }

    let end = if raw_end.is_empty() {
        (start + MAX_OPEN_RANGE_CHUNK - 1).min(total - 1)
    } else {
        let parsed_end: u64 = raw_end.parse().ok()?;
        if parsed_end < start {
            return None;
        }
        parsed_end.min(total - 1)
    };

    Some(ByteRange { start, end })
}

pub fn serve_media_request_sync(
    request: Request<Vec<u8>>,
    allowlist: &MediaAllowlist,
) -> Response<Vec<u8>> {
    if request.method() == "OPTIONS" {
        return with_cors_headers(Response::builder().status(StatusCode::NO_CONTENT))
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let target = match parse_media_uri(request.uri()) {
        Ok(t) => t,
        Err(StatusCode::NOT_FOUND) => {
            return plain_response(StatusCode::NOT_FOUND, "Unknown media host")
        }
        Err(_) => return plain_response(StatusCode::BAD_REQUEST, "Bad request"),
    };

    let resolved_path = match target {
        MediaTarget::Art(raw) => allowlist.resolve_contained_artwork(&raw),
        MediaTarget::File(raw) => allowlist.resolve_allowed_media(&raw),
    };

    let Some(file_path) = resolved_path else {
        return plain_response(StatusCode::FORBIDDEN, "Forbidden");
    };

    let metadata = match std::fs::metadata(&file_path) {
        Ok(m) if m.is_file() => m,
        _ => return plain_response(StatusCode::NOT_FOUND, "Not found"),
    };

    let total_size = metadata.len();
    let content_type = mime_for_path(&file_path);
    let is_head = request.method() == "HEAD";

    let range_header = request
        .headers()
        .get("range")
        .or_else(|| request.headers().get("Range"))
        .and_then(|v| v.to_str().ok());

    if let Some(raw_range) = range_header {
        let Some(range) = parse_range_header(raw_range, total_size) else {
            return with_cors_headers(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                .header("Content-Range", format!("bytes */{total_size}"))
                .body(Vec::new())
                .unwrap_or_else(|_| Response::new(Vec::new()));
        };

        let chunk_len = (range.end - range.start + 1) as usize;
        let body = if is_head {
            Vec::new()
        } else {
            let mut file = match File::open(&file_path) {
                Ok(f) => f,
                Err(_) => return plain_response(StatusCode::NOT_FOUND, "Not found"),
            };
            if file.seek(SeekFrom::Start(range.start)).is_err() {
                return plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Seek error");
            }
            let mut buf = vec![0u8; chunk_len];
            match file.read(&mut buf) {
                Ok(n) => {
                    buf.truncate(n);
                    buf
                }
                Err(_) => return plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Read error"),
            }
        };

        let actual_len = if is_head { chunk_len } else { body.len() };
        let actual_end = if actual_len > 0 {
            range.start + actual_len as u64 - 1
        } else {
            range.start
        };

        return with_cors_headers(Response::builder().status(StatusCode::PARTIAL_CONTENT))
            .header("Content-Type", content_type)
            .header("Accept-Ranges", "bytes")
            .header(
                "Content-Range",
                format!("bytes {}-{actual_end}/{total_size}", range.start),
            )
            .header("Content-Length", actual_len.to_string())
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    if is_head {
        return with_cors_headers(Response::builder().status(StatusCode::OK))
            .header("Content-Type", content_type)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", total_size.to_string())
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let body = match std::fs::read(&file_path) {
        Ok(bytes) => bytes,
        Err(_) => return plain_response(StatusCode::NOT_FOUND, "Not found"),
    };

    with_cors_headers(Response::builder().status(StatusCode::OK))
        .header("Content-Type", content_type)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string())
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle_async_media_protocol(
    allowlist: Arc<MediaAllowlist>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let response = serve_media_request_sync(request, &allowlist);
        responder.respond(response);
    });
}
