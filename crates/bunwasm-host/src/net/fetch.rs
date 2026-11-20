//! Outgoing HTTP(S) for the `fetch` / `fetch_head` / `read` slots.
//!
//! Each request runs on its own thread: it sends the request with reqwest
//! (hyper keeps the server's reason phrase, which ureq drops),
//! publishes the response head, then streams the (decoded) body into the
//! handle's queue, pausing while the guest has a lot unread.

use std::collections::VecDeque;
use std::future::{Future, poll_fn};
use std::io::{self, BufRead, BufReader, Read};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::task::{Poll, Waker};
use std::thread;

use reqwest::Client;
use reqwest::header::{self as http_header, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};

use super::error::{ErrorInfo, fetch_error};
use super::{AGAIN, BADF, ByteQueue, ERROR, Notify, Output, READ_HIGH_WATER};

const ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";
const MAX_REDIRECTS: usize = 20;

#[derive(Default)]
pub struct Clients {
    manual: OnceLock<Arc<Transport>>,
}

impl Clients {
    fn get(&self) -> Result<Arc<Transport>, SendError> {
        let cell = &self.manual;
        if let Some(client) = cell.get() {
            return Ok(client.clone());
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|error| SendError::Policy(invalid(error.to_string(), "EAGAIN")))?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Async reqwest defaults to no deadline; the guest owns cancellation.
            .user_agent(concat!("bun-wasm/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(SendError::Network)?;
        let transport = Arc::new(Transport { client, runtime });
        Ok(cell.get_or_init(|| transport).clone())
    }
}

/// Keep the shared pool's I/O running while body workers wait on backpressure.
struct Transport {
    client: Client,
    runtime: tokio::runtime::Runtime,
}

impl Transport {
    fn wait<T>(
        &self,
        shared: &Shared,
        future: impl Future<Output = Result<T, reqwest::Error>>,
    ) -> Result<T, SendError> {
        let mut future = std::pin::pin!(future);
        let result = self.runtime.block_on(poll_fn(|cx| {
            let mut state = shared.state.lock().unwrap();
            if state.aborted {
                return Poll::Ready(Err(SendError::Aborted));
            }
            state.waker = Some(cx.waker().clone());
            drop(state);
            future.as_mut().poll(cx).map_err(SendError::Network)
        }));
        shared.state.lock().unwrap().waker = None;
        result
    }
}

/// Preserve the synchronous decoder interface, but make every network read
/// interruptible, including a read waiting for the next response chunk.
struct ResponseReader {
    response: reqwest::Response,
    transport: Arc<Transport>,
    shared: Arc<Shared>,
    chunk: bytes::Bytes,
}

impl Read for ResponseReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.chunk.is_empty() {
            let next = self.transport.wait(&self.shared, self.response.chunk());
            let Some(chunk) = next.map_err(SendError::into_io)? else {
                return Ok(0);
            };
            self.chunk = chunk;
        }
        let count = buf.len().min(self.chunk.len());
        buf[..count].copy_from_slice(&self.chunk.split_to(count));
        Ok(count)
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
    #[serde(default, rename = "credentialPolicy")]
    credential_policy: Option<String>,
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
    waker: Option<Waker>,
    upload: UploadQueue,
}

/// Request body bytes the guest wrote to a `fetch_stream` handle, not yet sent.
#[derive(Default)]
struct UploadQueue {
    chunks: VecDeque<bytes::Bytes>,
    queued: usize,
    /// The guest called `shutdown`: the body ends after the queued chunks.
    ended: bool,
    /// The request no longer takes body bytes (sent, failed or replaced by a redirect).
    closed: bool,
    waker: Option<Waker>,
    /// The caller's Content-Length, which the body must match exactly.
    declared: Option<u64>,
    /// Bytes handed to hyper so far.
    sent: u64,
    /// Why the body failed, reported instead of hyper's error for it.
    error: Option<ErrorInfo>,
}

impl UploadQueue {
    /// Bun's error when a streamed body does not match its Content-Length: the
    /// count is the bytes produced up to the chunk that overflowed, or all of them.
    fn mismatch(&mut self, declared: u64) -> io::Error {
        let message = format!(
            "Request body of {} bytes does not match the Content-Length of {declared}",
            self.sent
        );
        self.error = Some(ErrorInfo::new(
            "Error",
            message.clone(),
            Some("ERR_HTTP_CONTENT_LENGTH_MISMATCH"),
        ));
        io::Error::other(message)
    }
}

/// `write` reports AGAIN while this much of the request body is unsent.
const UPLOAD_HIGH_WATER: usize = 256 * 1024;

/// The request body the guest supplied.
pub enum Upload {
    /// The whole body, sent with a Content-Length.
    Bytes(Vec<u8>),
    /// Chunks the guest writes to the handle until `shutdown`. Without a
    /// Content-Length header it goes out chunked, one chunk per write.
    Stream,
}

enum RequestBody {
    None,
    Bytes(Vec<u8>),
    Stream,
}

/// The `fetch_stream` body as hyper reads it: each queued write is one data frame.
struct UploadBody {
    shared: Arc<Shared>,
    notify: Arc<Notify>,
}

impl hyper::body::Body for UploadBody {
    type Data = bytes::Bytes;
    type Error = io::Error;

    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<bytes::Bytes>, io::Error>>> {
        let mut state = self.shared.state.lock().unwrap();
        if state.aborted {
            return Poll::Ready(Some(Err(io::ErrorKind::ConnectionAborted.into())));
        }
        let upload = &mut state.upload;
        if let Some(chunk) = upload.chunks.pop_front() {
            upload.queued -= chunk.len();
            upload.sent += chunk.len() as u64;
            // A chunk past the declared length is not sent: the request fails.
            let overflow = upload.declared.filter(|&declared| upload.sent > declared);
            let frame = match overflow {
                Some(declared) => Err(upload.mismatch(declared)),
                None => Ok(hyper::body::Frame::data(chunk)),
            };
            drop(state);
            // The guest may be waiting to write more.
            self.notify.bump();
            return Poll::Ready(Some(frame));
        }
        if upload.ended {
            if let Some(declared) = upload.declared.filter(|&declared| upload.sent < declared) {
                return Poll::Ready(Some(Err(upload.mismatch(declared))));
            }
            return Poll::Ready(None);
        }
        state.upload.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for UploadBody {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap();
        state.upload.closed = true;
        state.upload.chunks.clear();
        state.upload.queued = 0;
        drop(state);
        self.notify.bump();
    }
}

struct Shared {
    state: Mutex<State>,
    /// Signals the request thread that the guest consumed body bytes or aborted.
    drained: Condvar,
}

pub struct Fetch {
    shared: Arc<Shared>,
    /// Started by `fetch_stream`: `write` and `shutdown` carry the body.
    streaming: bool,
}

fn invalid(message: impl Into<String>, code: &str) -> ErrorInfo {
    ErrorInfo::new("TypeError", message, Some(code))
}

impl Fetch {
    /// Validates the request and starts it on a background thread. Errors
    /// known up front (bad JSON, URL, method, header) are returned directly.
    pub fn start(
        clients: &Arc<Clients>,
        meta: &[u8],
        upload: Upload,
        notify: Arc<Notify>,
    ) -> Result<Fetch, ErrorInfo> {
        let streaming = matches!(upload, Upload::Stream);
        let meta: Meta = serde_json::from_slice(meta).map_err(|e| {
            invalid(
                format!("invalid fetch request: {e}"),
                "ERR_INVALID_ARG_TYPE",
            )
        })?;
        let redirect = match meta.redirect.as_deref() {
            None | Some("follow") => Redirect::Follow,
            Some("manual") => Redirect::Manual,
            Some("error") => Redirect::Error,
            Some(other) => {
                return Err(invalid(
                    format!("invalid redirect mode: {other}"),
                    "ERR_INVALID_ARG_VALUE",
                ));
            }
        };
        let url = Url::parse(&meta.url)
            .map_err(|_| invalid("fetch() URL is invalid", "ERR_INVALID_URL"))?;
        match url.scheme() {
            "http" | "https" => {}
            _ => {
                return Err(invalid(
                    "protocol must be http:, https: or s3:",
                    "ERR_INVALID_ARG_VALUE",
                ));
            }
        }
        if url.host_str().is_none() {
            return Err(invalid("fetch() URL is invalid", "ERR_INVALID_URL"));
        }
        let method =
            Method::from_bytes(meta.method.to_ascii_uppercase().as_bytes()).map_err(|_| {
                invalid(
                    format!("'{}' is not a valid HTTP method.", meta.method),
                    "ERR_INVALID_ARG_VALUE",
                )
            })?;

        let mut headers = HeaderMap::new();
        for (name, value) in &meta.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                invalid(
                    format!("Invalid header name: '{name}'"),
                    "ERR_INVALID_HTTP_TOKEN",
                )
            })?;
            // The client frames the body itself. A streamed body keeps the caller's
            // Content-Length, as in Bun: it is then sent raw instead of chunked.
            if name == http_header::TRANSFER_ENCODING
                || name == http_header::CONTENT_LENGTH && !streaming
            {
                continue;
            }
            let value = HeaderValue::from_str(value).map_err(|_| {
                invalid(
                    format!("Invalid header value for '{name}'"),
                    "ERR_INVALID_CHAR",
                )
            })?;
            headers.append(name, value);
        }
        if !headers.contains_key(http_header::ACCEPT_ENCODING) {
            headers.insert(
                http_header::ACCEPT_ENCODING,
                HeaderValue::from_static(ACCEPT_ENCODING),
            );
        }
        let bodiless = method == Method::GET || method == Method::HEAD;
        // Bun frames every other method's body, even an empty or absent one, with a
        // Content-Length (`content-length: 0`).
        let body = match upload {
            _ if bodiless => RequestBody::None,
            Upload::Stream => RequestBody::Stream,
            Upload::Bytes(bytes) => RequestBody::Bytes(bytes),
        };
        // hyper writes no header for an empty body.
        if matches!(&body, RequestBody::Bytes(bytes) if bytes.is_empty()) {
            headers.insert(http_header::CONTENT_LENGTH, HeaderValue::from_static("0"));
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            drained: Condvar::new(),
        });
        {
            let mut state = shared.state.lock().unwrap();
            state.upload.closed = !matches!(body, RequestBody::Stream);
            state.upload.declared = headers
                .get(http_header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()?.trim().parse().ok())
                .filter(|_| streaming);
        }
        let request = Request {
            method,
            url,
            headers,
            body,
        };
        let package = meta.credential_policy.as_deref() == Some("package");
        let job = Job {
            clients: clients.clone(),
            shared: shared.clone(),
            notify,
            redirect,
            package,
        };
        thread::Builder::new()
            .name("bun-wasm-fetch".into())
            .spawn(move || job.run(request))
            .map_err(|e| invalid(format!("failed to start request: {e}"), "EAGAIN"))?;
        Ok(Fetch { shared, streaming })
    }

    /// Queue request body bytes of a `fetch_stream` request. ERROR once the
    /// request takes no more body (it failed, finished or was redirected).
    pub fn write(&self, data: &[u8]) -> i32 {
        if !self.streaming {
            return BADF;
        }
        let mut state = self.shared.state.lock().unwrap();
        let upload = &mut state.upload;
        if upload.closed || upload.ended {
            return ERROR;
        }
        if data.is_empty() {
            return 0;
        }
        if upload.queued >= UPLOAD_HIGH_WATER {
            return AGAIN;
        }
        upload.queued += data.len();
        upload.chunks.push_back(bytes::Bytes::copy_from_slice(data));
        if let Some(waker) = upload.waker.take() {
            waker.wake();
        }
        data.len() as i32
    }

    /// End a `fetch_stream` request's body after the queued bytes.
    pub fn end_body(&self) -> i32 {
        if !self.streaming {
            return BADF;
        }
        let mut state = self.shared.state.lock().unwrap();
        state.upload.ended = true;
        if let Some(waker) = state.upload.waker.take() {
            waker.wake();
        }
        0
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

    /// Wake pending network I/O as well as workers paused on body backpressure.
    pub fn abort(self) {
        let mut state = self.shared.state.lock().unwrap();
        state.aborted = true;
        let wakers = [state.waker.take(), state.upload.waker.take()];
        drop(state);
        self.shared.drained.notify_all();
        for waker in wakers.into_iter().flatten() {
            waker.wake();
        }
    }
}

struct Request {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: RequestBody,
}

struct Job {
    clients: Arc<Clients>,
    shared: Arc<Shared>,
    notify: Arc<Notify>,
    redirect: Redirect,
    package: bool,
}

impl Job {
    fn run(self, request: Request) {
        let url = request.url.to_string();
        let host = request.url.host_str().unwrap_or_default().to_string();
        let is_head = request.method == Method::HEAD;
        let result = self.clients.get().and_then(|transport| {
            self.send(
                &transport,
                &url,
                request.method,
                request.url.clone(),
                request.headers,
                request.body,
            )
            .map(|(response, final_url)| (response, final_url, transport))
        });
        let (response, final_url, transport) = match result {
            Ok(response) => response,
            Err(SendError::Aborted) => return,
            Err(SendError::Network(error)) => {
                let upload = self.shared.state.lock().unwrap().upload.error.take();
                self.finish_head(Err(
                    upload.unwrap_or_else(|| fetch_error(&error, &url, &host))
                ));
                return;
            }
            Err(SendError::Policy(error)) => {
                self.finish_head(Err(error));
                return;
            }
        };

        let status = response.status();
        // Bun rejects a redirect status under "error" even without a Location;
        // 300, 304, 305 and 306 are not redirects and come back as they are.
        if self.redirect == Redirect::Error && is_redirect_status(status) {
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
            url: final_url.to_string(),
            redirected: final_url != request.url,
            body_encoding: None,
            // Bun reports the original content-encoding/-length even though
            // the body is decoded, so the headers pass through unchanged. Each
            // value byte is one character (Latin-1), as Bun and browsers read them.
            headers: response
                .headers()
                .iter()
                .map(|(name, value)| {
                    let value = value.as_bytes().iter().map(|&byte| char::from(byte));
                    (name.as_str().to_string(), value.collect())
                })
                .collect(),
        };
        let encoding = response
            .headers()
            .get(http_header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_ascii_lowercase());
        let no_body =
            is_head || status == StatusCode::NO_CONTENT || status == StatusCode::NOT_MODIFIED;
        if !self.finish_head(Ok(serde_json::to_vec(&head).expect("head serializes"))) {
            return;
        }
        if no_body {
            return self.finish_body(None);
        }
        let reader = ResponseReader {
            response,
            transport,
            shared: self.shared.clone(),
            chunk: bytes::Bytes::new(),
        };
        match decoder(encoding.as_deref(), reader) {
            Ok(reader) => self.pump(reader),
            Err(error) => self.finish_body(Some(body_error(&error))),
        }
    }

    fn send(
        &self,
        transport: &Transport,
        requested: &str,
        mut method: Method,
        mut url: Url,
        mut headers: HeaderMap,
        mut body: RequestBody,
    ) -> Result<(reqwest::Response, Url), SendError> {
        for redirects in 0..=MAX_REDIRECTS {
            // A fragment is never sent (a long one would not even fit an HTTP
            // request target), but the response URL keeps it, as in Bun.
            let mut wire = url.clone();
            wire.set_fragment(None);
            let mut builder = transport
                .client
                .request(method.clone(), wire)
                .headers(headers.clone());
            match &body {
                RequestBody::None => {}
                RequestBody::Bytes(bytes) => builder = builder.body(bytes.clone()),
                RequestBody::Stream => {
                    builder = builder.body(reqwest::Body::wrap(UploadBody {
                        shared: self.shared.clone(),
                        notify: self.notify.clone(),
                    }));
                }
            }
            let response = transport.wait(&self.shared, builder.send())?;
            let status = response.status();
            let Some(location) = response.headers().get(http_header::LOCATION) else {
                return Ok((response, url));
            };
            if self.redirect != Redirect::Follow || !is_redirect_status(status) {
                return Ok((response, url));
            }
            // A stream has no source to send again: only a 303, which drops the
            // body, is followed (Fetch's HTTP-redirect fetch, step 11, as in Bun).
            if matches!(body, RequestBody::Stream) && status != StatusCode::SEE_OTHER {
                return Err(SendError::Policy(ErrorInfo::new(
                    "TypeError",
                    "Request body is a ReadableStream and cannot be replayed for this redirect",
                    None,
                )));
            }
            if redirects == MAX_REDIRECTS {
                return Err(SendError::Policy(invalid(
                    "The response redirected too many times",
                    "TooManyRedirects",
                )));
            }
            let next = location
                .to_str()
                .ok()
                .and_then(|location| url.join(location).ok())
                .ok_or_else(|| {
                    SendError::Policy(invalid(
                        "RedirectURLInvalid: Redirect URL in Location header is invalid.",
                        "RedirectURLInvalid",
                    ))
                })?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(SendError::Policy(invalid(
                    format!(
                        "UnsupportedRedirectProtocol fetching \"{requested}\". For more information, pass `verbose: true` in the second argument to fetch()"
                    ),
                    "UnsupportedRedirectProtocol",
                )));
            }
            if self.package && unsafe_package_redirect(&next) {
                return Err(SendError::Policy(invalid(
                    "Credential-bearing or unsupported package redirect URL",
                    "ERR_INVALID_URL",
                )));
            }
            redirect_headers(&mut headers, &url, &next);
            if status == StatusCode::SEE_OTHER && method != Method::HEAD
                || matches!(status.as_u16(), 301 | 302) && method == Method::POST
            {
                method = Method::GET;
                body = RequestBody::None;
                headers.remove(http_header::CONTENT_LENGTH);
                headers.remove(http_header::CONTENT_TYPE);
                headers.remove(http_header::TRANSFER_ENCODING);
            }
            url = next;
        }
        unreachable!()
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

enum SendError {
    Aborted,
    Network(reqwest::Error),
    Policy(ErrorInfo),
}

impl SendError {
    fn into_io(self) -> io::Error {
        match self {
            Self::Network(error) => io::Error::other(error),
            Self::Aborted => io::Error::from(io::ErrorKind::ConnectionAborted),
            Self::Policy(error) => io::Error::other(error.message),
        }
    }
}

/// The WHATWG redirect statuses. Other 3xx responses are final.
fn is_redirect_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn redirect_headers(headers: &mut HeaderMap, current: &Url, next: &Url) {
    if current.origin() == next.origin() {
        return;
    }
    for name in [
        "authorization",
        "cookie",
        "cookie2",
        "proxy-authorization",
        "www-authenticate",
    ] {
        headers.remove(name);
    }
}

fn unsafe_package_redirect(url: &Url) -> bool {
    let text = url.as_str().to_ascii_lowercase();
    !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || [
            ":_authtoken=",
            ":_auth=",
            ":username=",
            ":_username=",
            ":_password=",
        ]
        .iter()
        .any(|key| text.contains(key))
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
fn decoder(
    encoding: Option<&str>,
    raw: impl Read + Send + 'static,
) -> io::Result<Box<dyn Read + Send>> {
    Ok(match encoding {
        Some("gzip" | "x-gzip") => Box::new(flate2::read::MultiGzDecoder::new(raw)),
        Some("br") => Box::new(brotli_decompressor::Decompressor::new(raw, 64 * 1024)),
        Some("zstd") => Box::new(zstd::stream::read::Decoder::new(raw)?),
        Some("deflate") => {
            // "deflate" is meant to be zlib-wrapped, but some servers send raw
            // deflate; browsers accept both, so sniff the zlib header.
            let mut raw = BufReader::new(raw);
            let zlib = match raw.fill_buf() {
                Ok([cmf, flg, ..]) => {
                    cmf & 0x0f == 8 && (u16::from(*cmf) << 8 | u16::from(*flg)) % 31 == 0
                }
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

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn redirect_authentication_uses_scheme_host_and_port() {
        let current = Url::parse("https://registry.invalid:443/registry").unwrap();
        for (destination, retained) in [
            ("https://registry.invalid/archive", true),
            ("http://registry.invalid:443/archive", false),
            ("https://registry.invalid:444/archive", false),
            ("https://other.invalid/archive", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(
                http_header::AUTHORIZATION,
                HeaderValue::from_static("Bearer fixture-scheme-secret"),
            );
            redirect_headers(&mut headers, &current, &Url::parse(destination).unwrap());
            assert_eq!(
                headers.contains_key(http_header::AUTHORIZATION),
                retained,
                "{destination}"
            );
        }
    }
}
