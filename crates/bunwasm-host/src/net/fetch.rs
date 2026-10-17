//! Outgoing HTTP(S) for the `fetch` / `fetch_head` / `read` slots.
//!
//! Each request runs on its own thread: it sends the request with reqwest
//! (blocking; hyper keeps the server's reason phrase, which ureq drops),
//! publishes the response head, then streams the (decoded) body into the
//! handle's queue, pausing while the guest has a lot unread.

use std::io::{self, BufRead, BufReader, Read};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;

use reqwest::blocking::Client;
use reqwest::header::{self as http_header, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::error::{ErrorInfo, fetch_error};
use super::{AGAIN, ByteQueue, ERROR, Notify, Output, READ_HIGH_WATER};

const ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";
const MAX_REDIRECTS: usize = 20;

/// One HTTP client per redirect mode (reqwest sets the policy per client),
/// created on first use so a program that never fetches pays nothing.
#[derive(Default)]
pub struct Clients {
    follow: OnceLock<Client>,
    manual: OnceLock<Client>,
}

impl Clients {
    fn get(&self, redirect: Redirect) -> Result<Client, reqwest::Error> {
        let (cell, policy) = match redirect {
            Redirect::Follow => (&self.follow, reqwest::redirect::Policy::limited(MAX_REDIRECTS)),
            Redirect::Manual | Redirect::Error => (&self.manual, reqwest::redirect::Policy::none()),
        };
        if let Some(client) = cell.get() {
            return Ok(client.clone());
        }
        let client = Client::builder()
            .redirect(policy)
            // Like Bun: no overall deadline; the guest aborts if it wants one.
            .timeout(None::<std::time::Duration>)
            .user_agent(concat!("bun-wasm/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(cell.get_or_init(|| client).clone())
    }
}

#[derive(Deserialize)]
struct Meta {
    #[serde(default = "default_method")]
    method: String,
    url: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    redirect: Option<String>,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Clone, Copy, PartialEq)]
enum Redirect {
    Follow,
    Manual,
    Error,
}

#[derive(Serialize)]
struct Head {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: String,
    url: String,
    redirected: bool,
    #[serde(rename = "bodyEncoding")]
    body_encoding: Option<String>,
    headers: Vec<(String, String)>,
}

#[derive(Default)]
struct State {
    /// `None` until the response head (or a network error) arrives.
    head: Option<Result<Vec<u8>, ErrorInfo>>,
    body: ByteQueue,
    eof: bool,
    body_error: Option<ErrorInfo>,
    aborted: bool,
}

struct Shared {
    state: Mutex<State>,
    /// Signals the request thread that the guest consumed body bytes or aborted.
    drained: Condvar,
}

pub struct Fetch {
    shared: Arc<Shared>,
}

fn invalid(message: impl Into<String>, code: &str) -> ErrorInfo {
    ErrorInfo::new("TypeError", message, Some(code))
}

impl Fetch {
    /// Validates the request and starts it on a background thread. Errors
    /// known up front (bad JSON, URL, method, header) are returned directly.
    pub fn start(clients: &Arc<Clients>, meta: &[u8], body: &[u8], notify: Arc<Notify>) -> Result<Fetch, ErrorInfo> {
        let meta: Meta =
            serde_json::from_slice(meta).map_err(|e| invalid(format!("invalid fetch request: {e}"), "ERR_INVALID_ARG_TYPE"))?;
        let redirect = match meta.redirect.as_deref() {
            None | Some("follow") => Redirect::Follow,
            Some("manual") => Redirect::Manual,
            Some("error") => Redirect::Error,
            Some(other) => return Err(invalid(format!("invalid redirect mode: {other}"), "ERR_INVALID_ARG_VALUE")),
        };
        let url = Url::parse(&meta.url).map_err(|_| invalid("fetch() URL is invalid", "ERR_INVALID_URL"))?;
        match url.scheme() {
            "http" | "https" => {}
            _ => return Err(invalid("protocol must be http:, https: or s3:", "ERR_INVALID_ARG_VALUE")),
        }
        if url.host_str().is_none() {
            return Err(invalid("fetch() URL is invalid", "ERR_INVALID_URL"));
        }
        let method = Method::from_bytes(meta.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| invalid(format!("'{}' is not a valid HTTP method.", meta.method), "ERR_INVALID_ARG_VALUE"))?;

        let mut headers = HeaderMap::new();
        for (name, value) in &meta.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| invalid(format!("Invalid header name: '{name}'"), "ERR_INVALID_HTTP_TOKEN"))?;
            // The client frames the body itself.
            if name == http_header::CONTENT_LENGTH || name == http_header::TRANSFER_ENCODING {
                continue;
            }
            let value = HeaderValue::from_str(value)
                .map_err(|_| invalid(format!("Invalid header value for '{name}'"), "ERR_INVALID_CHAR"))?;
            headers.append(name, value);
        }
        if !headers.contains_key(http_header::ACCEPT_ENCODING) {
            headers.insert(http_header::ACCEPT_ENCODING, HeaderValue::from_static(ACCEPT_ENCODING));
        }
        let body = (!body.is_empty() && method != Method::GET && method != Method::HEAD).then(|| body.to_vec());
        let request = Request { method, url, headers, body };

        let shared = Arc::new(Shared { state: Mutex::new(State::default()), drained: Condvar::new() });
        let job = Job { clients: clients.clone(), shared: shared.clone(), notify, redirect };
        thread::Builder::new()
            .name("bun-wasm-fetch".into())
            .spawn(move || job.run(request))
            .map_err(|e| invalid(format!("failed to start request: {e}"), "EAGAIN"))?;
        Ok(Fetch { shared })
    }

    pub fn head(&self) -> Output {
        match &self.shared.state.lock().unwrap().head {
            None => Output::Code(AGAIN),
            Some(Err(_)) => Output::Code(ERROR),
            Some(Ok(json)) => Output::Bytes(json.clone()),
        }
    }

    pub fn read(&self, buf: &mut [u8]) -> i32 {
        let mut state = self.shared.state.lock().unwrap();
        match &state.head {
            None => return AGAIN,
            Some(Err(_)) => return ERROR,
            Some(Ok(_)) => {}
        }
        if !state.body.is_empty() {
            let n = state.body.pop_into(buf);
            self.shared.drained.notify_all();
            return n as i32;
        }
        if state.body_error.is_some() {
            ERROR
        } else if state.eof {
            0
        } else {
            AGAIN
        }
    }

    pub fn error(&self) -> Option<ErrorInfo> {
        let state = self.shared.state.lock().unwrap();
        match &state.head {
            Some(Err(error)) => Some(error.clone()),
            _ => state.body_error.clone(),
        }
    }

    /// Stops the request: the thread drops the connection at its next step.
    pub fn abort(self) {
        self.shared.state.lock().unwrap().aborted = true;
        self.shared.drained.notify_all();
    }
}

struct Request {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
}

struct Job {
    clients: Arc<Clients>,
    shared: Arc<Shared>,
    notify: Arc<Notify>,
    redirect: Redirect,
}

impl Job {
    fn run(self, request: Request) {
        let url = request.url.to_string();
        let host = request.url.host_str().unwrap_or_default().to_string();
        let is_head = request.method == Method::HEAD;
        let result = self.clients.get(self.redirect).and_then(|client| {
            let mut builder = client.request(request.method, request.url.clone()).headers(request.headers);
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            builder.send()
        });
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                self.finish_head(Err(fetch_error(&error, &url, &host)));
                return;
            }
        };

        let status = response.status();
        if self.redirect == Redirect::Error && status.is_redirection() && response.headers().contains_key(http_header::LOCATION)
        {
            let message = format!(
                "UnexpectedRedirect fetching \"{url}\". For more information, pass `verbose: true` in the second argument to fetch()"
            );
            self.finish_head(Err(invalid(message, "UnexpectedRedirect")));
            return;
        }

        // hyper records the reason phrase only when it isn't the canonical one.
        let status_text = match response.extensions().get::<hyper::ext::ReasonPhrase>() {
            Some(reason) => String::from_utf8_lossy(reason.as_bytes()).into_owned(),
            None => status.canonical_reason().unwrap_or("").to_string(),
        };
        let head = Head {
            status: status.as_u16(),
            status_text,
            url: response.url().to_string(),
            redirected: *response.url() != request.url,
            body_encoding: None,
            // Bun reports the original content-encoding/-length even though
            // the body is decoded, so the headers pass through unchanged.
            headers: response
                .headers()
                .iter()
                .map(|(name, value)| (name.as_str().to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned()))
                .collect(),
        };
        let encoding = response
            .headers()
            .get(http_header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_ascii_lowercase());
        let no_body = is_head || status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED;
        if !self.finish_head(Ok(serde_json::to_vec(&head).expect("head serializes"))) {
            return;
        }
        if no_body {
            return self.finish_body(None);
        }
        match decoder(encoding.as_deref(), response) {
            Ok(reader) => self.pump(reader),
            Err(error) => self.finish_body(Some(body_error(&error))),
        }
    }

    /// Publishes the head. Returns false if the guest already aborted.
    fn finish_head(&self, head: Result<Vec<u8>, ErrorInfo>) -> bool {
        let mut state = self.shared.state.lock().unwrap();
        let alive = !state.aborted;
        state.head = Some(head);
        drop(state);
        self.notify.bump();
        alive
    }

    fn finish_body(&self, error: Option<ErrorInfo>) {
        let mut state = self.shared.state.lock().unwrap();
        state.eof = true;
        state.body_error = error;
        drop(state);
        self.notify.bump();
    }

    fn pump(&self, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            {
                let mut state = self.shared.state.lock().unwrap();
                while state.body.len() >= READ_HIGH_WATER && !state.aborted {
                    state = self.shared.drained.wait(state).unwrap();
                }
                if state.aborted {
                    return;
                }
            }
            match reader.read(&mut buf) {
                Ok(0) => return self.finish_body(None),
                Ok(n) => {
                    self.shared.state.lock().unwrap().body.push(&buf[..n]);
                    self.notify.bump();
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return self.finish_body(Some(body_error(&e))),
            }
        }
    }
}

fn body_error(err: &io::Error) -> ErrorInfo {
    if err.kind() == io::ErrorKind::InvalidData || err.kind() == io::ErrorKind::InvalidInput {
        return invalid(format!("Decompression error: {err}"), "ZlibError");
    }
    invalid(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        "ECONNRESET",
    )
}

/// Wraps the raw body in a decoder for its `content-encoding`. Unknown or
/// stacked encodings pass through undecoded.
fn decoder(encoding: Option<&str>, raw: impl Read + Send + 'static) -> io::Result<Box<dyn Read + Send>> {
    Ok(match encoding {
        Some("gzip" | "x-gzip") => Box::new(flate2::read::MultiGzDecoder::new(raw)),
        Some("br") => Box::new(brotli_decompressor::Decompressor::new(raw, 64 * 1024)),
        Some("zstd") => Box::new(zstd::stream::read::Decoder::new(raw)?),
        Some("deflate") => {
            // "deflate" is meant to be zlib-wrapped, but some servers send raw
            // deflate; browsers accept both, so sniff the zlib header.
            let mut raw = BufReader::new(raw);
            let zlib = match raw.fill_buf() {
                Ok([cmf, flg, ..]) => cmf & 0x0f == 8 && (u16::from(*cmf) << 8 | u16::from(*flg)) % 31 == 0,
                _ => true,
            };
            if zlib {
                Box::new(flate2::read::ZlibDecoder::new(raw))
            } else {
                Box::new(flate2::read::DeflateDecoder::new(raw))
            }
        }
        _ => Box::new(raw),
    })
}
