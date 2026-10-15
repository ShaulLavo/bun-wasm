//! Error descriptions returned by the `error` slot, shaped like the JS
//! errors native Bun throws for the same failures.

use std::io;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct ErrorInfo {
    pub name: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syscall: Option<String>,
}

impl ErrorInfo {
    pub fn new(name: &str, message: impl Into<String>, code: Option<&str>) -> Self {
        ErrorInfo { name: name.into(), message: message.into(), code: code.map(Into::into), syscall: None }
    }

    pub fn with_syscall(mut self, syscall: &str) -> Self {
        self.syscall = Some(syscall.into());
        self
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("ErrorInfo serializes")
    }
}

/// POSIX-style code for an I/O error (`ECONNREFUSED`, ...), as Node reports them.
pub fn errno_code(err: &io::Error) -> &'static str {
    use io::ErrorKind::*;
    match err.kind() {
        ConnectionRefused => "ECONNREFUSED",
        ConnectionReset => "ECONNRESET",
        ConnectionAborted => "ECONNABORTED",
        AddrInUse => "EADDRINUSE",
        AddrNotAvailable => "EADDRNOTAVAIL",
        BrokenPipe => "EPIPE",
        TimedOut => "ETIMEDOUT",
        PermissionDenied => "EACCES",
        HostUnreachable => "EHOSTUNREACH",
        NetworkUnreachable => "ENETUNREACH",
        NetworkDown => "ENETDOWN",
        NotConnected => "ENOTCONN",
        InvalidInput => "EINVAL",
        // std reports getaddrinfo failures as uncategorized errors.
        _ if is_dns_error(err) => "ENOTFOUND",
        _ => "EIO",
    }
}

pub fn is_dns_error(err: &io::Error) -> bool {
    let text = err.to_string();
    text.contains("failed to lookup address") || text.contains("Name or service not known")
}

/// A socket error in Node's format: `connect ECONNREFUSED 127.0.0.1:9`.
pub fn socket_error(syscall: &str, err: &io::Error, target: &str) -> ErrorInfo {
    let code = errno_code(err);
    let message = if code == "ENOTFOUND" {
        format!("getaddrinfo ENOTFOUND {}", target.rsplit_once(':').map_or(target, |(host, _)| host))
    } else {
        format!("{syscall} {code} {target}")
    };
    let syscall = if code == "ENOTFOUND" { "getaddrinfo" } else { syscall };
    ErrorInfo::new("Error", message, Some(code)).with_syscall(syscall)
}

/// A `fetch` failure, using Bun's messages and codes where they are known.
pub fn fetch_error(err: &reqwest::Error, url: &str, host: &str) -> ErrorInfo {
    let type_error = |message: String, code: &str| ErrorInfo::new("TypeError", message, Some(code));
    // reqwest wraps hyper, which wraps the I/O or TLS error that matters.
    let mut io = None;
    let mut tls = None;
    let mut text = String::new();
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(error) = source {
        if let Some(e) = error.downcast_ref::<io::Error>() {
            io.get_or_insert(e);
        }
        if let Some(e) = error.downcast_ref::<rustls::Error>() {
            tls.get_or_insert(e);
        }
        text.push_str(&error.to_string());
        text.push_str(": ");
        source = error.source();
    }
    if let Some(tls) = tls {
        return tls_error(tls);
    }
    if err.is_redirect() {
        return type_error(
            "The response redirected too many times. For more information, pass `verbose: true` in the second argument to fetch()".into(),
            "TooManyRedirects",
        );
    }
    if err.is_timeout() {
        return type_error(format!("The operation timed out fetching \"{url}\""), "Timeout");
    }
    if text.contains("dns error") || text.contains("failed to lookup address") {
        return type_error(format!("getaddrinfo ENOTFOUND {host}"), "ENOTFOUND").with_syscall("getaddrinfo");
    }
    if let Some(io) = io {
        return io_fetch_error(io, host);
    }
    if err.is_connect() {
        return type_error("Unable to connect. Is the computer able to access the url?".into(), "ConnectionRefused");
    }
    if err.is_builder() {
        return type_error("fetch() URL is invalid".into(), "ERR_INVALID_URL");
    }
    type_error(
        format!("{} fetching \"{url}\"", text.trim_end_matches(": ")),
        if err.is_body() || err.is_request() { "ConnectionClosed" } else { "FetchError" },
    )
}

fn io_fetch_error(io: &io::Error, host: &str) -> ErrorInfo {
    use io::ErrorKind::*;
    // TLS failures during the handshake surface as I/O errors wrapping rustls's.
    if let Some(tls) = io.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
        return tls_error(tls);
    }
    let (message, code) = match io.kind() {
        ConnectionRefused => ("Unable to connect. Is the computer able to access the url?".to_string(), "ConnectionRefused"),
        ConnectionReset | BrokenPipe => {
            ("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()".to_string(), "ECONNRESET")
        }
        TimedOut => ("The operation timed out.".to_string(), "Timeout"),
        UnexpectedEof => {
            ("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()".to_string(), "ConnectionClosed")
        }
        _ if is_dns_error(io) => {
            return ErrorInfo::new("TypeError", format!("getaddrinfo ENOTFOUND {host}"), Some("ENOTFOUND"))
                .with_syscall("getaddrinfo");
        }
        _ => (io.to_string(), errno_code(io)),
    };
    ErrorInfo::new("TypeError", message, Some(code))
}

/// Certificate failures with the OpenSSL-style codes Node and Bun use.
fn tls_error(err: &rustls::Error) -> ErrorInfo {
    use rustls::CertificateError as C;
    let (message, code) = match err {
        rustls::Error::InvalidCertificate(C::Expired | C::ExpiredContext { .. }) => {
            ("certificate has expired", "CERT_HAS_EXPIRED")
        }
        rustls::Error::InvalidCertificate(C::NotValidForName | C::NotValidForNameContext { .. }) => {
            ("Hostname/IP does not match certificate's altnames", "ERR_TLS_CERT_ALTNAME_INVALID")
        }
        rustls::Error::InvalidCertificate(C::UnknownIssuer) => {
            ("unable to get local issuer certificate", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
        }
        rustls::Error::InvalidCertificate(_) => ("certificate verify failed", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"),
        _ => return ErrorInfo::new("TypeError", format!("TLS handshake failed: {err}"), Some("ERR_TLS_HANDSHAKE")),
    };
    ErrorInfo::new("TypeError", message, Some(code))
}
