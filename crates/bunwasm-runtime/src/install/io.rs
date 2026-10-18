use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Transpiler, encoding, host};

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct Registry {
    pub url: String,
    authorization: Option<String>,
}

impl Registry {
    pub fn new(url: &str) -> Result<Self> {
        Ok(Self {
            url: source_url(url)?.trim_end_matches('/').into(),
            authorization: None,
        })
    }

    pub fn configured(value: &Value) -> Result<Self> {
        let mut registry = Self::new(
            value["url"]
                .as_str()
                .ok_or("Registry configuration requires a URL")?,
        )?;
        let token = auth_field(value, "token")?;
        let username = auth_field(value, "username")?;
        let password = auth_field(value, "password")?;
        registry.authorization = match (token, username, password) {
            (Some(token), _, _) => Some(format!("Bearer {token}")),
            (_, Some(username), Some(password)) => Some(format!(
                "Basic {}",
                encoding::base64_encode(format!("{username}:{password}").as_bytes(), false)
            )),
            (_, None, None) => None,
            _ => return Err("Registry authentication requires both username and password".into()),
        };
        Ok(registry)
    }

    fn authorization_for(&self, url: &url::Url) -> Option<&str> {
        let registry = url::Url::parse(&self.url).ok()?;
        let path = registry.path().trim_end_matches('/');
        let same_registry = url.origin() == registry.origin()
            && (url.path() == path || url.path().starts_with(&format!("{path}/")));
        same_registry
            .then_some(self.authorization.as_deref())
            .flatten()
    }

    fn redact(&self, message: &str) -> String {
        let message = redact(message);
        match self
            .authorization
            .as_ref()
            .and_then(|value| value.split_once(' '))
        {
            Some((scheme, value)) => {
                let message = message.replace(value, "[redacted]");
                if scheme != "Basic" {
                    return message;
                }
                let decoded = String::from_utf8(encoding::base64_decode(value)).unwrap_or_default();
                match decoded.split_once(':') {
                    Some((_, password)) if !password.is_empty() => {
                        message.replace(password, "[redacted]")
                    }
                    _ => message,
                }
            }
            None => message,
        }
    }
}

fn auth_field<'a>(config: &'a Value, field: &str) -> Result<Option<&'a str>> {
    if config[field].is_null() {
        return Ok(None);
    }
    let value = config[field]
        .as_str()
        .ok_or("Registry authentication must use strings")?;
    if value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("Registry authentication contains an invalid header value".into());
    }
    Ok((!value.is_empty()).then_some(value))
}

fn request_url(value: &str) -> Result<url::Url> {
    if [":_authToken=", ":_auth=", ":username=", ":_password="]
        .iter()
        .any(|key| value.contains(key))
    {
        return Err(
            "Embedded registry authentication is not supported for package installation".into(),
        );
    }
    let mut url = url::Url::parse(value).map_err(|_| "Invalid registry or tarball URL")?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("Registry and tarball URLs must use http or https".into());
    }
    if url.query().is_some() {
        return Err(
            "Credential-bearing URL query is not supported for package installation".into(),
        );
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    Ok(url)
}

pub fn source_url(value: &str) -> Result<String> {
    Ok(request_url(value)?.into())
}

pub fn redact(message: &str) -> String {
    let mut result = String::new();
    let mut rest = message;
    while let Some(at) = rest.find("://") {
        let start = rest[..at]
            .char_indices()
            .rev()
            .take_while(|(_, character)| {
                character.is_ascii_alphanumeric() || "+-.".contains(*character)
            })
            .last()
            .map_or(at, |(index, _)| index);
        let end = rest[at + 3..]
            .find(|character: char| character.is_whitespace() || "\"'<>".contains(character))
            .map_or(rest.len(), |offset| at + 3 + offset);
        result.push_str(&rest[..start]);
        result.push_str(&redact_url(&rest[start..end]));
        rest = &rest[end..];
    }
    result.push_str(rest);
    result
}

fn redact_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return "[redacted URL]".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.into()
}

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
        Some(4) => {
            serde_json::from_str(value[1].as_str().unwrap_or("null")).map_err(|e| e.to_string())
        }
        Some(5) => {
            let units = value[1].as_array().ok_or("Invalid string")?;
            Ok(Value::String(String::from_utf16_lossy(
                &units
                    .iter()
                    .map(|v| v.as_u64().unwrap_or(0) as u16)
                    .collect::<Vec<_>>(),
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
            PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| ".".into()))
                .join(".bun/install/cache/bun-wasm")
        })
}

pub fn fetch(url: &str, tarball: bool, refresh: bool, registry: &Registry) -> Result<Vec<u8>> {
    let url_value = request_url(url)?;
    let url = url_value.as_str();
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
        if cacheable(&bytes, tarball, registry) {
            return Ok(bytes);
        }
        fs::remove_file(&cache).map_err(|_| "Could not discard unsafe registry cache data")?;
    }
    let bytes = request(&url_value, tarball, refresh, registry)?;
    if cacheable(&bytes, tarball, registry) && fs::create_dir_all(cache_dir()).is_ok() {
        let _ = write(&cache, &bytes);
    }
    Ok(bytes)
}

fn cacheable(bytes: &[u8], tarball: bool, registry: &Registry) -> bool {
    if tarball {
        return true;
    }
    let Ok(metadata) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let text = metadata.to_string();
    registry.redact(&text) == text
}

fn request(
    url_value: &url::Url,
    tarball: bool,
    refresh: bool,
    registry: &Registry,
) -> Result<Vec<u8>> {
    let url = url_value.as_str();
    let accept = if tarball {
        "application/vnd.bun.install-tarball"
    } else {
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
    };
    let mut headers = json!([["accept", accept], ["accept-encoding", "gzip"]]);
    if let Some(authorization) = registry.authorization_for(url_value) {
        headers
            .as_array_mut()
            .unwrap()
            .push(json!(["authorization", authorization]));
    }
    if refresh {
        headers
            .as_array_mut()
            .unwrap()
            .push(json!(["cache-control", "no-cache"]));
    }
    let meta = json!({"method":"GET", "url":url, "headers":headers, "redirect":"follow"});
    let handle = host::fetch(meta.to_string().as_bytes(), &[]);
    if handle < 0 {
        return Err(network_error(handle, registry));
    }
    let result = response(handle, url, registry);
    host::close(handle);
    result
}

fn response(handle: i32, url: &str, registry: &Registry) -> Result<Vec<u8>> {
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
            Err(_) => return Err(network_error(handle, registry)),
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
            Err(_) => return Err(network_error(handle, registry)),
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

fn network_error(handle: i32, registry: &Registry) -> String {
    if handle == host::UNSUPPORTED {
        return "Package installation needs a host with networking support".into();
    }
    host::error(handle)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| {
            v["message"]
                .as_str()
                .map(|message| registry.redact(message))
        })
        .unwrap_or_else(|| "Registry request failed".into())
}

fn parsed_integrity(sri: &str) -> Option<(&'static str, Vec<u8>)> {
    for (algorithm, size) in [("sha512", 64), ("sha384", 48), ("sha256", 32), ("sha1", 20)] {
        let prefix = format!("{algorithm}-");
        let digest = sri
            .split_whitespace()
            .filter_map(|entry| entry.strip_prefix(&prefix))
            .find_map(|entry| integrity_digest(entry, size));
        if let Some(digest) = digest {
            return Some((algorithm, digest));
        }
    }
    None
}

fn integrity_digest(entry: &str, size: usize) -> Option<Vec<u8>> {
    let entry = entry.split('?').next()?.trim_end_matches('=');
    if !entry
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"+/".contains(&byte))
    {
        return None;
    }
    let bytes = encoding::base64_decode(entry);
    (bytes.len() == size).then_some(bytes)
}

pub fn normalized_integrity(sri: &str) -> Option<String> {
    let (algorithm, bytes) = parsed_integrity(sri)?;
    let base64 = encoding::base64_encode(&bytes, false);
    let padding = if algorithm == "sha1" { "=" } else { "==" };
    Some(format!(
        "{algorithm}-{}{padding}",
        base64.trim_end_matches('=')
    ))
}

pub fn integrity(bytes: &[u8], sri: &str) -> Result<()> {
    if sri.is_empty() {
        return Ok(());
    }
    let (algorithm, expected) = parsed_integrity(sri).ok_or(
        "Missing or unsupported package integrity (expected sha512, sha384, sha256 or sha1)",
    )?;
    if encoding::digest(algorithm, bytes).unwrap() == expected {
        return Ok(());
    }
    Err(format!("Integrity check failed ({algorithm})"))
}

pub fn extract(bytes: &[u8], destination: &Path) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(LIMIT as u64 + 1));
    let entries = archive
        .entries()
        .map_err(|e| format!("Invalid tarball: {e}"))?;
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
