use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256, Sha512};

use crate::{Transpiler, encoding, host};

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 256 * 1024 * 1024;

pub fn parsed(source: &[u8], format: &str, parser: &dyn Transpiler) -> Result<Value> {
    let graph = parser.parse_data(source, format).map_err(|e| e.message)?;
    let graph: Value = serde_json::from_str(&graph).map_err(|e| e.to_string())?;
    decode(&graph["root"], &graph["nodes"], 0)
}

fn decode(value: &Value, nodes: &Value, depth: usize) -> Result<Value> {
    if depth > 128 {
        return Err("Package data exceeds nesting limit".into());
    }
    match value[0].as_u64() {
        Some(0) => Ok(value[1].clone()),
        Some(4) => serde_json::from_str(value[1].as_str().unwrap_or("null")).map_err(|e| e.to_string()),
        Some(5) => {
            let units = value[1].as_array().ok_or("Invalid string")?;
            Ok(Value::String(String::from_utf16_lossy(
                &units.iter().map(|v| v.as_u64().unwrap_or(0) as u16).collect::<Vec<_>>(),
            )))
        }
        Some(1) => decode_node(
            &nodes[value[1].as_u64().ok_or("Invalid data reference")? as usize],
            nodes,
            depth + 1,
        ),
        _ => Err("Unsupported value in package data".into()),
    }
}

fn decode_node(node: &Value, nodes: &Value, depth: usize) -> Result<Value> {
    let items = node[1].as_array().ok_or("Invalid parsed data")?;
    if node[0] == "array" {
        return items.iter().map(|v| decode(v, nodes, depth)).collect();
    }
    let mut object = serde_json::Map::new();
    for item in items {
        let key = decode(&item[0], nodes, depth)?;
        object.insert(
            key.as_str().ok_or("Invalid property name")?.into(),
            decode(&item[1], nodes, depth)?,
        );
    }
    Ok(Value::Object(object))
}

pub fn read(path: &Path, format: &str, parser: &dyn Transpiler) -> Result<Value> {
    parsed(
        &fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
        format,
        parser,
    )
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("bun-wasm-tmp-{:x}", u128::from_le_bytes(random)));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let written = file.write_all(bytes);
    drop(file);
    let result = written.and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e: std::io::Error| e.to_string())
}

pub fn cache_dir() -> PathBuf {
    std::env::var_os("BUN_INSTALL_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into())).join(".bun/install/cache/bun-wasm")
        })
}

pub fn fetch(url: &str, tarball: bool, refresh: bool) -> Result<Vec<u8>> {
    let cache = cache_dir().join(format!("{:x}", Sha256::digest(url.as_bytes())));
    let fresh = tarball
        || fs::metadata(&cache)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < Duration::from_secs(300));
    if !refresh
        && fresh
        && let Ok(bytes) = fs::read(&cache)
    {
        return Ok(bytes);
    }
    let bytes = request(url, tarball, refresh)?;
    if fs::create_dir_all(cache_dir()).is_ok() {
        let _ = write(&cache, &bytes);
    }
    Ok(bytes)
}

fn request(url: &str, tarball: bool, refresh: bool) -> Result<Vec<u8>> {
    let url_value = url::Url::parse(url).map_err(|_| format!("Invalid registry URL: {url}"))?;
    if !matches!(url_value.scheme(), "http" | "https") {
        return Err("Registry must use http or https".into());
    }
    let accept = if tarball {
        "application/vnd.bun.install-tarball"
    } else {
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
    };
    let mut headers = json!([["accept", accept], ["accept-encoding", "gzip"]]);
    if refresh {
        headers
            .as_array_mut()
            .unwrap()
            .push(json!(["cache-control", "no-cache"]));
    }
    let meta = json!({"method":"GET", "url":url, "headers":headers, "redirect":"follow"});
    let handle = host::fetch(meta.to_string().as_bytes(), &[]);
    if handle < 0 {
        return Err(network_error(handle));
    }
    let result = response(handle, url);
    host::close(handle);
    result
}

fn response(handle: i32, url: &str) -> Result<Vec<u8>> {
    let seconds = std::env::var("BUN_CONFIG_HTTP_IDLE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(300);
    let timeout = Duration::from_secs(seconds);
    let mut progress = Instant::now();
    let head = loop {
        match host::fetch_head(handle) {
            Ok(head) => break head,
            Err(host::AGAIN) => wait(progress, timeout, url)?,
            Err(_) => return Err(network_error(handle)),
        }
    };
    let head: Value = serde_json::from_slice(&head).map_err(|e| e.to_string())?;
    let status = head["status"].as_u64().unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(format!("GET {url} - {status}"));
    }
    let mut out = Vec::new();
    progress = Instant::now();
    loop {
        match host::read(handle, 64 * 1024) {
            Ok(bytes) if bytes.is_empty() => return Ok(out),
            Ok(bytes) => {
                out.extend_from_slice(&bytes);
                progress = Instant::now();
            }
            Err(host::AGAIN) => wait(progress, timeout, url)?,
            Err(_) => return Err(network_error(handle)),
        }
        if out.len() > LIMIT {
            return Err("Download exceeds 256 MiB limit".into());
        }
    }
}

fn wait(progress: Instant, timeout: Duration, url: &str) -> Result<()> {
    if progress.elapsed() >= timeout {
        return Err(format!("Timeout downloading {url}"));
    }
    let remaining = timeout.saturating_sub(progress.elapsed());
    host::poll(remaining.as_millis().clamp(1, 1000) as i32);
    Ok(())
}

fn network_error(handle: i32) -> String {
    if handle == host::UNSUPPORTED {
        return "Package installation needs a host with networking support".into();
    }
    host::error(handle)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "Registry request failed".into())
}

pub fn integrity(bytes: &[u8], sri: &str) -> Result<()> {
    if sri.is_empty() {
        return Ok(());
    }
    let hashes: Vec<_> = sri
        .split_whitespace()
        .filter_map(|s| s.strip_prefix("sha512-"))
        .collect();
    if !hashes.is_empty() {
        let actual = encoding::base64_encode(&Sha512::digest(bytes), false);
        if hashes.contains(&actual.as_str()) {
            return Ok(());
        }
        return Err("Integrity check failed (sha512)".into());
    }
    let actual = encoding::base64_encode(&encoding::digest("sha1", bytes).unwrap(), false);
    if sri
        .split_whitespace()
        .any(|s| s.strip_prefix("sha1-") == Some(actual.as_str()))
    {
        return Ok(());
    }
    Err("Missing or unsupported package integrity (expected sha512 or sha1)".into())
}

pub fn extract(bytes: &[u8], destination: &Path) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(LIMIT as u64 + 1));
    let entries = archive.entries().map_err(|e| format!("Invalid tarball: {e}"))?;
    let mut total = 0u64;
    for entry in entries {
        let mut entry = entry.map_err(|e| e.to_string())?;
        total = total.checked_add(entry.size()).ok_or("Tarball too large")?;
        if total > LIMIT as u64 {
            return Err("Extracted package exceeds 256 MiB".into());
        }
        extract_entry(&mut entry, destination)?;
    }
    Ok(())
}

fn extract_entry<R: Read>(entry: &mut tar::Entry<'_, R>, destination: &Path) -> Result<()> {
    let path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Normal(_))) {
        return Err("Unsafe tarball path".into());
    }
    let tail: PathBuf = parts.collect();
    if tail.as_os_str().is_empty() {
        return Ok(());
    }
    if !tail.components().all(|p| matches!(p, Component::Normal(_))) {
        return Err("Unsafe tarball path".into());
    }
    let target = destination.join(tail);
    let kind = entry.header().entry_type();
    if kind.is_dir() {
        return fs::create_dir_all(target).map_err(|e| e.to_string());
    }
    if !kind.is_file() {
        return Err(format!("Unsupported tarball entry: {}", path.display()));
    }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut out = fs::File::create(&target).map_err(|e| e.to_string())?;
    std::io::copy(entry, &mut out).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}
