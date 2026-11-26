use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{pending::Pending, trace};
use crate::{Transpiler, encoding, host};

pub type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct Registry {
    pub url: String,
    authorization: Option<String>,
    secrets: Vec<String>,
}

impl Registry {
    pub fn new(url: &str) -> Result<Self> {
        Ok(Self {
            url: source_url(url)?.trim_end_matches('/').into(),
            authorization: None,
            secrets: Vec::new(),
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
        registry.secrets = [token, password]
            .into_iter()
            .flatten()
            .map(str::to_owned)
            .collect();
        if let Some((_, value)) = registry
            .authorization
            .as_deref()
            .and_then(|value| value.split_once(' '))
        {
            registry.secrets.push(value.into());
        }
        Ok(registry)
    }

    fn authorization_for(&self, url: &url::Url) -> Option<&str> {
        let registry = url::Url::parse(&self.url).ok()?;
        (url.origin() == registry.origin())
            .then_some(self.authorization.as_deref())
            .flatten()
    }

    fn safe_text(&self, message: &str) -> bool {
        // Every authentication marker and every URL contains ':', so most strings (names,
        // versions, ranges) need only the secret check, without allocating.
        if !message.contains(':') {
            // Replacing a secret that is itself the placeholder changes nothing.
            return !self
                .secrets
                .iter()
                .any(|secret| secret != "[redacted]" && message.contains(secret.as_str()));
        }
        !has_embedded_auth(message) && self.redact(message) == message
    }

    pub fn safe_metadata(&self, value: &Value) -> bool {
        match value {
            Value::String(value) => self.safe_text(value),
            Value::Array(values) => values.iter().all(|value| self.safe_metadata(value)),
            Value::Object(values) => values
                .iter()
                .all(|(key, value)| self.safe_text(key) && self.safe_metadata(value)),
            _ => true,
        }
    }

    pub fn redact(&self, message: &str) -> String {
        self.secrets
            .iter()
            .fold(redact(message), |message, secret| {
                message.replace(secret, "[redacted]")
            })
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
    if has_embedded_auth(value) {
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
    if has_embedded_auth(message) {
        return "[redacted registry authentication]".into();
    }
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

fn has_embedded_auth(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        ":_authtoken=",
        ":_auth=",
        ":username=",
        ":_username=",
        ":_password=",
    ]
    .iter()
    .any(|key| lower.contains(key))
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
    write_atomically(path, bytes).map_err(|e| e.to_string())
}

/// `write`, keeping the I/O error so callers can tell its kind.
pub(super) fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
    let temp = path.with_extension(format!("bun-wasm-tmp-{:x}", u128::from_le_bytes(random)));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = file.write_all(bytes);
    drop(file);
    let result = written.and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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
    Downloads::new(0).fetch(url, tarball, refresh, registry)
}

fn cache_path(url: &str) -> PathBuf {
    cache_dir().join(format!("{:x}", Sha256::digest(url.as_bytes())))
}

/// The install cache directory, created at most once per `Downloads`: each filesystem call
/// is a host round trip in the browser. A write that fails with `NotFound` because the
/// directory has since disappeared creates it again and retries once; any other failure
/// leaves the entry absent, as before.
pub(super) struct CacheWriter {
    created: bool,
    /// The host keeps no install cache (`BUN_WASM_INSTALL_CACHE=off`): nothing is read or
    /// written. The browser page hosts set it, because the browser's HTTP cache already
    /// keeps registry responses, and writing them into the workspace filesystem costs more
    /// than reading them back saves.
    off: bool,
}

impl Default for CacheWriter {
    fn default() -> Self {
        Self {
            created: false,
            off: std::env::var_os("BUN_WASM_INSTALL_CACHE").is_some_and(|value| value == "off"),
        }
    }
}

impl CacheWriter {
    /// Whether the install cache is in use.
    pub(super) fn enabled(&self) -> bool {
        !self.off
    }

    /// Writes `bytes` as the cache file for `url`.
    pub(super) fn store(&mut self, url: &str, bytes: &[u8]) {
        self.store_with(url, bytes, write_atomically);
    }

    /// `store` with the atomic write it uses passed in, so tests can make it fail.
    pub(super) fn store_with(
        &mut self,
        url: &str,
        bytes: &[u8],
        mut write: impl FnMut(&Path, &[u8]) -> std::io::Result<()>,
    ) {
        if self.off {
            return;
        }
        if !self.created && fs::create_dir_all(cache_dir()).is_err() {
            return;
        }
        self.created = true;
        let path = cache_path(url);
        let Err(error) = write(&path, bytes) else {
            return;
        };
        // Only a write that found no cache directory is retried; any other error stands.
        let missing = error.kind() == std::io::ErrorKind::NotFound && !cache_dir().exists();
        if missing && fs::create_dir_all(cache_dir()).is_ok() {
            let _ = write(&path, bytes);
        }
    }
}

/// Tarballs are immutable; metadata stays fresh for five minutes.
fn fresh_cache(cache: &Path, tarball: bool) -> bool {
    tarball
        || fs::metadata(cache)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age < Duration::from_secs(300))
}

/// The cached response for `url`, when it is fresh and passes the same safety checks.
fn cached(url: &url::Url, tarball: bool, registry: &Registry) -> Result<Option<Vec<u8>>> {
    let cache = cache_path(url.as_str());
    if !fresh_cache(&cache, tarball) {
        return Ok(None);
    }
    let Ok(bytes) = trace::time("cache-read", || fs::read(&cache)) else {
        return Ok(None);
    };
    if cacheable(&bytes, tarball, registry) {
        return Ok(Some(bytes));
    }
    fs::remove_file(&cache).map_err(|_| "Could not discard unsafe registry cache data")?;
    Ok(None)
}

/// Metadata lookahead requests in flight. One more handle stays free for a demand lookup
/// that conservative lookahead did not predict. Registry metadata is small and
/// latency-bound, and registries serve it over HTTP/2 (browsers queue extra HTTP/1.1
/// requests per connection), so a wide window hides round trips.
pub(super) const METADATA_PREFETCHES: usize = 63;
/// Tarball requests in flight. Installs consume archives in order, so a narrower window
/// leaves more bandwidth to the archive being waited for.
pub(super) const TARBALL_PREFETCHES: usize = 31;
/// Guest memory that bodies nobody waits for yet may fill. Past it, they wait under the
/// host's per-handle backpressure as before.
const PREFETCH_BUFFER: usize = 32 * 1024 * 1024;
/// Largest single host read.
const READ_CAP: usize = 256 * 1024;
/// How often long guest work (extraction) lets other responses move.
const PUMP_INTERVAL: Duration = Duration::from_millis(4);

/// Owns handles in the order they will be consumed. While the installer waits for one
/// response or extracts one package, the others keep reading within `PREFETCH_BUFFER`.
pub struct Downloads {
    limit: usize,
    pending: Vec<(String, Result<Download>)>,
    pumped: Option<Instant>,
    /// One read buffer for every response: a read that finds nothing allocates nothing,
    /// and bodies grow only by the bytes that arrived.
    scratch: Vec<u8>,
    cache: CacheWriter,
}

impl Downloads {
    /// Holds at most `limit` prefetched requests.
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            pending: Vec::new(),
            pumped: None,
            scratch: Vec::new(),
            cache: CacheWriter::default(),
        }
    }

    fn scratch(&mut self) -> &mut [u8] {
        self.scratch.resize(READ_CAP, 0);
        &mut self.scratch
    }

    pub fn is_full(&self) -> bool {
        self.pending.len() >= self.limit
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }

    pub fn retain(&mut self, urls: &[String]) {
        self.pending.retain(|(url, _)| urls.contains(url));
    }

    fn contains(&self, url: &str) -> bool {
        self.pending.iter().any(|(pending, _)| pending == url)
    }

    fn take(&mut self, url: &str) -> Option<Result<Download>> {
        let index = self
            .pending
            .iter()
            .position(|(pending, _)| pending == url)?;
        Some(self.pending.remove(index).1)
    }

    pub fn prefetch(&mut self, url: &str, tarball: bool, refresh: bool, registry: &Registry) {
        if self.is_full() || self.contains(url) {
            return;
        }
        let request = request_url(url).and_then(|url| {
            let cache = cache_path(url.as_str());
            if !refresh && self.cache.enabled() && fresh_cache(&cache, tarball) && cache.is_file() {
                return Ok(None);
            }
            Download::start(&url, tarball, refresh, registry).map(Some)
        });
        match request {
            Ok(None) => {}
            Ok(Some(request)) => self.pending.push((url.into(), Ok(request))),
            Err(error) => self.pending.push((url.into(), Err(error))),
        }
    }

    pub fn fetch(
        &mut self,
        url: &str,
        tarball: bool,
        refresh: bool,
        registry: &Registry,
    ) -> Result<Vec<u8>> {
        let download = match self.take(url) {
            Some(request) => request?,
            None => {
                let url = request_url(url)?;
                if !refresh
                    && self.cache.enabled()
                    && let Some(bytes) = cached(&url, tarball, registry)?
                {
                    return Ok(bytes);
                }
                Download::start(&url, tarball, refresh, registry)?
            }
        };
        download.finish(self, registry)
    }

    /// Lets other responses move during long guest work, at most every `PUMP_INTERVAL`.
    pub fn tick(&mut self, registry: &Registry) {
        let now = Instant::now();
        if self
            .pumped
            .is_some_and(|at| now.duration_since(at) < PUMP_INTERVAL)
        {
            return;
        }
        self.pumped = Some(now);
        self.pump(registry);
    }

    /// Reads what the host already holds for pending responses, in consumption order.
    /// Buffered bodies are counted by capacity, so `PREFETCH_BUFFER` bounds what they reserve.
    fn pump(&mut self, registry: &Registry) {
        let mut buffered: usize = self
            .pending
            .iter()
            .filter_map(|(_, download)| download.as_ref().ok())
            .map(|download| download.body.capacity())
            .sum();
        self.scratch();
        for (_, download) in &mut self.pending {
            let Ok(download) = download else {
                continue;
            };
            let before = download.body.capacity();
            download.advance(
                PREFETCH_BUFFER.saturating_sub(buffered),
                &mut self.scratch,
                registry,
            );
            // A failed download dropped its body, so it may have shrunk.
            buffered = (buffered + download.body.capacity()).saturating_sub(before);
        }
    }
}

/// How a body read stopped.
#[derive(Debug, PartialEq)]
enum BodyRead {
    /// The body's capacity reached its ceiling; the rest waits for a later read.
    Paused,
    /// The body ended.
    Ended,
    /// The body passed `limit`; the extra bytes were not kept.
    TooLarge,
    /// The reader returned this negative code (`host::AGAIN` when nothing has arrived yet).
    Stopped(i32),
}

/// Appends what `read` yields until it would block or the body ends. The body's capacity
/// grows by at most `budget` bytes and never past `limit`: growth doubles like `Vec` but
/// is clamped to that ceiling with `reserve_exact`. Each read asks for at most the scratch
/// size and the room left under the ceiling; at `limit` it asks for one byte, enough to
/// tell a body of exactly `limit` bytes from a larger one.
fn read_body(
    body: &mut Vec<u8>,
    scratch: &mut [u8],
    budget: usize,
    limit: usize,
    mut read: impl FnMut(&mut [u8]) -> std::result::Result<usize, i32>,
) -> BodyRead {
    let ceiling = limit.min(body.capacity().saturating_add(budget));
    loop {
        let probe = usize::from(ceiling == limit);
        let cap = scratch.len().min(ceiling - body.len() + probe);
        if cap == 0 {
            return BodyRead::Paused;
        }
        let count = match read(&mut scratch[..cap]) {
            Ok(0) => return BodyRead::Ended,
            Ok(count) => count.min(cap),
            Err(code) => return BodyRead::Stopped(code),
        };
        if body.len() + count > limit {
            return BodyRead::TooLarge;
        }
        grow_within(body, count, ceiling);
        body.extend_from_slice(&scratch[..count]);
    }
}

/// Makes room for `count` more bytes, doubling the capacity but never past `ceiling`.
fn grow_within(body: &mut Vec<u8>, count: usize, ceiling: usize) {
    let needed = body.len() + count;
    if body.capacity() >= needed {
        return;
    }
    let target = (body.capacity() * 2).max(needed).min(ceiling);
    body.reserve_exact(target - body.len());
}

enum Body {
    Head,
    Reading,
    Done,
    Failed(String),
}

struct Download {
    handle: i32,
    url: String,
    tarball: bool,
    body: Vec<u8>,
    state: Body,
}

impl Download {
    fn start(url: &url::Url, tarball: bool, refresh: bool, registry: &Registry) -> Result<Self> {
        Ok(Self {
            handle: start_request(url, tarball, refresh, registry)?,
            url: url.as_str().into(),
            tarball,
            body: Vec::new(),
            state: Body::Head,
        })
    }

    fn finish(mut self, others: &mut Downloads, registry: &Registry) -> Result<Vec<u8>> {
        let (download, store) = if self.tarball {
            ("tarball-download", "tarball-cache-write")
        } else {
            ("metadata-download", "metadata-cache-write")
        };
        let started = trace::start_time();
        let completed = self.complete(others, registry);
        // Failed attempts count too, with whatever arrived (a failure frees the body).
        trace::finish(download, started, self.body.len());
        completed?;
        let bytes = std::mem::take(&mut self.body);
        trace::time(store, || {
            if others.cache.enabled() && cacheable(&bytes, self.tarball, registry) {
                others.cache.store(&self.url, &bytes);
            }
        });
        Ok(bytes)
    }

    /// Waits for the whole response. The idle timer starts here, on consumption.
    fn complete(&mut self, others: &mut Downloads, registry: &Registry) -> Result<()> {
        let mut pending = Pending::new(idle_timeout(), Instant::now());
        loop {
            // Others first: a notification for this response that arrives after its read
            // below still ends the wait.
            others.pump(registry);
            if self.advance(usize::MAX, others.scratch(), registry) {
                pending.progressed(Instant::now());
            }
            match &self.state {
                Body::Done => return Ok(()),
                Body::Failed(error) => return Err(error.clone()),
                Body::Head | Body::Reading => wait(&mut pending, &self.url)?,
            }
        }
    }

    /// Moves the response forward without blocking, reading at most `budget` body bytes.
    /// Returns whether anything changed. Only a head, body bytes or the end of the body
    /// count: an unanswered request must still reach its idle timeout.
    fn advance(&mut self, budget: usize, scratch: &mut [u8], registry: &Registry) -> bool {
        let head = matches!(self.state, Body::Head) && self.read_head(registry);
        if !matches!(self.state, Body::Reading) {
            return head;
        }
        let start = self.body.len();
        let handle = self.handle;
        let outcome = read_body(&mut self.body, scratch, budget, LIMIT, |buf| {
            host::read_to(handle, buf)
        });
        match outcome {
            BodyRead::Paused | BodyRead::Stopped(host::AGAIN) => {
                return head || self.body.len() > start;
            }
            BodyRead::Ended => self.state = Body::Done,
            BodyRead::TooLarge => self.fail("Download exceeds 256 MiB limit".into()),
            BodyRead::Stopped(_) => self.fail(network_error(handle, registry)),
        }
        true
    }

    /// Records the error and frees the buffered body now, not when the request is consumed.
    fn fail(&mut self, error: String) {
        self.body = Vec::new();
        self.state = Body::Failed(error);
    }

    /// Reads the response head if it arrived. Returns whether it did (or failed).
    fn read_head(&mut self, registry: &Registry) -> bool {
        let head = match host::fetch_head(self.handle) {
            Ok(head) => head,
            Err(host::AGAIN) => return false,
            Err(_) => {
                self.fail(network_error(self.handle, registry));
                return true;
            }
        };
        match response_status(&head) {
            Ok(status) if (200..300).contains(&status) => self.state = Body::Reading,
            Ok(status) => self.fail(format!("GET {} - {status}", self.url)),
            Err(error) => self.fail(error),
        }
        true
    }
}

fn response_status(head: &[u8]) -> Result<u64> {
    let head: Value = serde_json::from_slice(head).map_err(|e| e.to_string())?;
    Ok(head["status"].as_u64().unwrap_or(0))
}

fn idle_timeout() -> Duration {
    let seconds = std::env::var("BUN_CONFIG_HTTP_IDLE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(300);
    Duration::from_secs(seconds)
}

impl Drop for Download {
    fn drop(&mut self) {
        host::close(self.handle);
    }
}

fn cacheable(bytes: &[u8], tarball: bool, registry: &Registry) -> bool {
    if tarball {
        return true;
    }
    let Ok(metadata) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    registry.safe_metadata(&metadata)
}

fn start_request(
    url_value: &url::Url,
    tarball: bool,
    refresh: bool,
    registry: &Registry,
) -> Result<i32> {
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
    let meta = json!({"method":"GET", "url":url, "headers":headers, "redirect":"follow", "credentialPolicy":"package"});
    let handle = host::fetch(meta.to_string().as_bytes(), &[]);
    if handle < 0 {
        return Err(network_error(handle, registry));
    }
    Ok(handle)
}

fn wait(pending: &mut Pending, url: &str) -> Result<()> {
    let timeout_ms = pending
        .next_poll_ms(Instant::now())
        .ok_or_else(|| format!("Timeout downloading {url}"))?;
    trace::time("net-idle", || host::poll(timeout_ms));
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

type ArchiveEntry<'a> = tar::Entry<'a, std::io::Take<flate2::read::GzDecoder<&'a [u8]>>>;

fn visit_archive(
    bytes: &[u8],
    mut visit: impl FnMut(&mut ArchiveEntry<'_>, &Path) -> Result<()>,
) -> Result<()> {
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
        let tail = archive_path(&entry)?;
        if !tail.as_os_str().is_empty() {
            visit(&mut entry, &tail)?;
        }
    }
    Ok(())
}

fn archive_path<R: Read>(entry: &tar::Entry<'_, R>) -> Result<PathBuf> {
    let path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Normal(_))) {
        return Err("Unsafe tarball path".into());
    }
    let tail: PathBuf = parts.collect();
    if !tail.components().all(|p| matches!(p, Component::Normal(_))) {
        return Err("Unsafe tarball path".into());
    }
    let kind = entry.header().entry_type();
    if !kind.is_file() && !kind.is_dir() {
        return Err(format!("Unsupported tarball entry: {}", path.display()));
    }
    Ok(tail)
}

pub fn archive_manifest(bytes: &[u8]) -> Result<Value> {
    let mut manifest = None;
    visit_archive(bytes, |entry, path| {
        if path != Path::new("package.json") {
            return Ok(());
        }
        if manifest.is_some() || !entry.header().entry_type().is_file() {
            return Err("Tarball needs one regular package.json".into());
        }
        manifest = Some(
            serde_json::from_reader(entry)
                .map_err(|e| format!("Invalid tarball package.json: {e}"))?,
        );
        Ok(())
    })?;
    manifest.ok_or_else(|| "Tarball has no package.json".into())
}

/// Extracts into `destination`, an existing empty directory. `tick` runs once per entry so
/// other downloads keep moving during long extractions.
pub fn extract(bytes: &[u8], destination: &Path, tick: &mut dyn FnMut()) -> Result<()> {
    let mut directories = Directories::new(destination);
    let mut buffer = Vec::new();
    visit_archive(bytes, |entry, path| {
        tick();
        let target = destination.join(path);
        if entry.header().entry_type().is_dir() {
            return directories.create(&target);
        }
        directories.create_parent(&target)?;
        // Grows to the largest file seen, exactly, and never past `EXTRACT_CHUNK`.
        let wanted = (entry.size() as usize).clamp(1, EXTRACT_CHUNK);
        if buffer.len() < wanted {
            buffer.reserve_exact(wanted - buffer.len());
            buffer.resize(wanted, 0);
        }
        write_entry(entry, &target, &mut buffer)
    })
}

/// The directories extraction created, so each costs one `mkdir` and files in them none.
struct Directories {
    known: BTreeSet<PathBuf>,
}

impl Directories {
    fn new(root: &Path) -> Self {
        Self {
            known: BTreeSet::from([root.to_path_buf()]),
        }
    }

    fn create_parent(&mut self, target: &Path) -> Result<()> {
        self.create(target.parent().unwrap())
    }

    /// `fs::create_dir_all` that skips the directories it already made or saw. Under a known
    /// parent it tries one `mkdir`; otherwise, or if that fails, it runs `create_dir_all` on
    /// the same path, so every error is the one `create_dir_all` reports.
    fn create(&mut self, path: &Path) -> Result<()> {
        if self.known.contains(path) {
            return Ok(());
        }
        let parent_known = path
            .parent()
            .is_some_and(|parent| self.known.contains(parent));
        if !parent_known || create_directory(path).is_err() {
            trace::time("extract-mkdir", || fs::create_dir_all(path)).map_err(|e| e.to_string())?;
        }
        if self.known.len() < 1024 {
            self.known.insert(path.to_path_buf());
        }
        Ok(())
    }
}

/// Each write is a host filesystem call in the browser, so files up to this size are
/// written with one call. Larger files stream through in chunks of this size.
const EXTRACT_CHUNK: usize = 256 * 1024;

/// Streams one archive file to `target` through `buffer`.
fn write_entry(entry: &mut impl Read, target: &Path, buffer: &mut [u8]) -> Result<()> {
    let mut file =
        trace::time("extract-write", || fs::File::create(target)).map_err(|e| e.to_string())?;
    loop {
        let count =
            trace::time("extract-inflate", || fill(entry, buffer)).map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        trace::time("extract-write", || file.write_all(&buffer[..count]))
            .map_err(|e| e.to_string())?;
        if count < buffer.len() {
            return Ok(());
        }
    }
}

/// Reads until `buffer` is full or the entry ends.
fn fill(entry: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match entry.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// One `mkdir` whose parent exists. An existing directory is fine, as with `create_dir_all`.
fn create_directory(path: &Path) -> Result<()> {
    trace::time("extract-mkdir", || match fs::create_dir(path) {
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        result => result,
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_cache_validation_rejects_malformed_and_credential_data() {
        let registry = Registry::configured(&json!({
            "url": "https://registry.invalid",
            "token": "synthetic-secret"
        }))
        .unwrap();
        let safe = json!({"versions": {"1.0.0": {"dist": {
            "tarball": "https://registry.invalid/package/-/package-1.0.0.tgz"
        }}}});
        assert!(cacheable(
            &serde_json::to_vec(&safe).unwrap(),
            false,
            &registry
        ));
        for unsafe_metadata in [
            json!({"tarball": "https://user:password@registry.invalid/package.tgz"}),
            json!({"description": "synthetic-secret"}),
        ] {
            let bytes = serde_json::to_vec(&unsafe_metadata).unwrap();
            assert!(!cacheable(&bytes, false, &registry));
        }
        assert!(!cacheable(b"{", false, &registry));
    }

    #[test]
    fn the_colon_free_fast_path_agrees_with_full_redaction() {
        let registry = Registry::configured(&json!({
            "url": "https://registry.invalid",
            "username": "user",
            "password": "pass-word"
        }))
        .unwrap();
        for text in [
            "^1.2.3",
            "left-pad",
            "my pass-word here",
            "dXNlcjpwYXNzLXdvcmQ=",
            "//registry.invalid/:_authToken=abc",
            "https://registry.invalid/a/-/a-1.0.0.tgz",
            "https://registry.invalid/a.tgz?token=1",
            "",
        ] {
            let full = !has_embedded_auth(text) && registry.redact(text) == text;
            assert_eq!(registry.safe_text(text), full, "{text:?}");
        }
        // A secret that is the placeholder itself: replacing it changes nothing.
        let placeholder = Registry::configured(&json!({
            "url": "https://registry.invalid",
            "token": "[redacted]"
        }))
        .unwrap();
        for text in ["see [redacted] here", "plain"] {
            let full = !has_embedded_auth(text) && placeholder.redact(text) == text;
            assert_eq!(placeholder.safe_text(text), full, "{text:?}");
        }
    }

    /// A reader that offers `available` bytes in total, then reports `then`.
    fn offering(
        available: usize,
        then: i32,
        caps: &mut Vec<usize>,
    ) -> impl FnMut(&mut [u8]) -> std::result::Result<usize, i32> + '_ {
        let mut left = available;
        move |buf| {
            caps.push(buf.len());
            if left == 0 {
                return if then == 0 { Ok(0) } else { Err(then) };
            }
            let count = buf.len().min(left);
            left -= count;
            buf[..count].fill(7);
            Ok(count)
        }
    }

    #[test]
    fn body_reads_stop_at_the_prefetch_budget() {
        let (mut body, mut scratch, mut caps) = (vec![1; 10], vec![0; 8], Vec::new());
        let outcome = read_body(
            &mut body,
            &mut scratch,
            20,
            1000,
            offering(100, 0, &mut caps),
        );
        assert_eq!(outcome, BodyRead::Paused);
        assert_eq!(body.len(), 30, "exactly the budget arrived");
        assert_eq!(body.capacity(), 30);
        assert_eq!(
            caps,
            [8, 8, 4],
            "the last read asks only for the rest of the budget"
        );
    }

    /// A reader that hands out `available` bytes `piece` at a time, then ends.
    fn pieces(
        available: usize,
        piece: usize,
    ) -> impl FnMut(&mut [u8]) -> std::result::Result<usize, i32> {
        let mut left = available;
        move |buf| {
            let count = buf.len().min(piece).min(left);
            left -= count;
            Ok(count)
        }
    }

    #[test]
    fn a_body_never_reserves_past_the_size_limit() {
        // Doubling from many small reads would reserve far past the limit.
        let (mut body, mut scratch) = (Vec::new(), vec![0; 64]);
        let outcome = read_body(&mut body, &mut scratch, usize::MAX, 1000, pieces(1000, 3));
        assert_eq!(outcome, BodyRead::Ended);
        assert_eq!(body.len(), 1000);
        assert!(body.capacity() <= 1000, "capacity {}", body.capacity());
    }

    #[test]
    fn prefetched_bodies_never_reserve_past_the_shared_budget() {
        // As `Downloads::pump` does: each body may grow by what the others left.
        let budget = 1000;
        let mut scratch = vec![0; 64];
        let mut bodies: Vec<Vec<u8>> = vec![Vec::new(), Vec::new(), Vec::new()];
        let mut reserved = 0;
        for body in &mut bodies {
            let before = body.capacity();
            read_body(
                body,
                &mut scratch,
                budget - reserved,
                usize::MAX - 1,
                pieces(700, 3),
            );
            reserved += body.capacity() - before;
        }
        let total: usize = bodies.iter().map(Vec::capacity).sum();
        assert!(total <= budget, "prefetched bodies reserved {total} bytes");
        assert_eq!(bodies[0].len(), 700);
        assert!(bodies[1].len() >= 200, "the second body used what was left");
    }

    #[test]
    fn a_body_read_that_finds_nothing_allocates_nothing() {
        let (mut body, mut scratch, mut caps) = (Vec::new(), vec![0; 8], Vec::new());
        let outcome = read_body(
            &mut body,
            &mut scratch,
            usize::MAX,
            1000,
            offering(0, host::AGAIN, &mut caps),
        );
        assert_eq!(outcome, BodyRead::Stopped(host::AGAIN));
        assert_eq!(body.capacity(), 0);
    }

    #[test]
    fn a_body_at_the_limit_probes_one_byte() {
        let (mut body, mut scratch, mut caps) = (Vec::new(), vec![0; 8], Vec::new());
        let outcome = read_body(
            &mut body,
            &mut scratch,
            usize::MAX,
            12,
            offering(12, 0, &mut caps),
        );
        assert_eq!(outcome, BodyRead::Ended);
        assert_eq!((body.len(), caps.as_slice()), (12, [8, 5, 1].as_slice()));
        let (mut body, mut caps) = (Vec::new(), Vec::new());
        let outcome = read_body(
            &mut body,
            &mut scratch,
            usize::MAX,
            12,
            offering(13, 0, &mut caps),
        );
        assert_eq!(outcome, BodyRead::TooLarge);
        assert!(body.len() <= 12, "bytes past the limit are not kept");
    }

    #[test]
    fn a_failed_download_drops_its_buffered_body() {
        let registry = Registry::new("https://registry.invalid").unwrap();
        let mut download = Download {
            handle: 1,
            url: "https://registry.invalid/package".into(),
            tarball: true,
            body: vec![0; 4096],
            state: Body::Reading,
        };
        // Off wasm, every host read fails, as a dropped connection would.
        assert!(download.advance(usize::MAX, &mut [0; 8], &registry));
        assert!(matches!(download.state, Body::Failed(_)));
        assert_eq!(download.body.capacity(), 0);
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    fn archive(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let compressor = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(compressor);
        for (path, kind, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(*kind);
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            archive.append(&header, *bytes).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn extracted(entries: &[(&str, tar::EntryType, &[u8])]) -> (PathBuf, Result<()>) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let index = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("bun-wasm-extract-{}-{index}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        let result = extract(&archive(entries), &root, &mut || {});
        (root, result)
    }

    #[test]
    fn extraction_creates_directories_once_and_reports_create_dir_all_errors() {
        use tar::EntryType::{Directory, Regular};
        let (root, result) = extracted(&[
            ("package/lib/", Directory, b""),
            ("package/lib/a.js", Regular, b"a"),
            ("package/deep/er/b.js", Regular, b"b"),
        ]);
        result.unwrap();
        assert_eq!(fs::read(root.join("lib/a.js")).unwrap(), b"a");
        assert_eq!(fs::read(root.join("deep/er/b.js")).unwrap(), b"b");
        fs::remove_dir_all(root).unwrap();
        for conflict in ["package/clash/inner.js", "package/clash/deeper/inner.js"] {
            let (root, result) = extracted(&[
                ("package/clash", Regular, b"file"),
                (conflict, Regular, b"x"),
            ]);
            let parent = Path::new(conflict)
                .strip_prefix("package")
                .unwrap()
                .parent()
                .unwrap();
            let expected = fs::create_dir_all(root.join(parent))
                .unwrap_err()
                .to_string();
            assert_eq!(result.unwrap_err(), expected, "{conflict}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn tarball_manifest_uses_extraction_safety_checks() {
        let manifest = b"{\"name\":\"tool\",\"version\":\"1.2.3\"}";
        let valid = (
            "package/package.json",
            tar::EntryType::Regular,
            manifest.as_slice(),
        );
        let bytes = archive(&[valid]);
        assert_eq!(archive_manifest(&bytes).unwrap()["name"], "tool");
        assert!(
            archive_manifest(&archive(&[]))
                .unwrap_err()
                .contains("no package.json")
        );
        assert!(
            archive_manifest(&archive(&[valid, valid]))
                .unwrap_err()
                .contains("one regular package.json")
        );
        let link = ("package/escape", tar::EntryType::Symlink, b"".as_slice());
        assert!(
            archive_manifest(&archive(&[valid, link]))
                .unwrap_err()
                .contains("Unsupported tarball entry")
        );
        let traversal = (
            "package/../../outside",
            tar::EntryType::Regular,
            b"escape".as_slice(),
        );
        assert!(
            archive_manifest(&archive(&[valid, traversal]))
                .unwrap_err()
                .contains("Unsafe tarball path")
        );
        assert!(archive_manifest(b"not a gzip archive").is_err());
    }
}
