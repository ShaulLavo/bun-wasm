//! Side-effect-free, asynchronous hostname resolution for the host ABI.
//!
//! The guest owns only the positive handle. The resolver worker owns copied host
//! input and publishes an owned JSON result into shared state; it never keeps a
//! guest pointer, store or engine reference.

use std::ffi::{CStr, CString};
use std::io;
use std::mem::size_of;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::ptr;
use std::sync::{Arc, Mutex};
use std::thread;

use super::Notify;
use super::error::ErrorInfo;

const DNS_ALL: i32 = 16;
const DNS_ADDRCONFIG: i32 = 32;
const DNS_V4MAPPED: i32 = 8;
const DNS_HINTS: i32 = DNS_ALL | DNS_ADDRCONFIG | DNS_V4MAPPED;

#[derive(Clone)]
pub struct Lookup {
    shared: Arc<LookupShared>,
}

struct LookupShared {
    state: Mutex<LookupState>,
    notify: Arc<Notify>,
}

struct LookupState {
    outcome: Option<Result<Vec<u8>, ErrorInfo>>,
    cancelled: bool,
}

impl Lookup {
    pub fn start(
        hostname: &str,
        family: i32,
        hints: i32,
        notify: Arc<Notify>,
    ) -> Result<Self, ErrorInfo> {
        validate(family, hints, hostname)?;
        let shared = Arc::new(LookupShared {
            state: Mutex::new(LookupState {
                outcome: None,
                cancelled: false,
            }),
            notify,
        });
        let worker_shared = shared.clone();
        let hostname = hostname.to_owned();
        let worker_hostname = hostname.clone();
        thread::Builder::new()
            .name("bun-wasm-dns".into())
            .stack_size(256 * 1024)
            .spawn(move || publish(worker_shared, &worker_hostname, family, hints))
            .map_err(|error| {
                ErrorInfo::new(
                    "Error",
                    format!("failed to start getaddrinfo worker: {error}"),
                    Some("EAGAIN"),
                )
                .with_syscall("getaddrinfo")
                .with_hostname(hostname)
            })?;
        Ok(Lookup { shared })
    }

    pub fn head(&self) -> super::Output {
        let state = self.shared.state.lock().unwrap();
        match &state.outcome {
            None => super::Output::Code(super::AGAIN),
            Some(Ok(bytes)) => super::Output::Bytes(bytes.clone()),
            Some(Err(_)) => super::Output::Code(super::ERROR),
        }
    }

    pub fn error(&self) -> Option<ErrorInfo> {
        let state = self.shared.state.lock().unwrap();
        match &state.outcome {
            Some(Err(error)) => Some(error.clone()),
            _ => None,
        }
    }

    fn cancel(&self) {
        self.shared.state.lock().unwrap().cancelled = true;
    }
}

impl Drop for Lookup {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn validate(family: i32, hints: i32, hostname: &str) -> Result<(), ErrorInfo> {
    if !matches!(family, 0 | 4 | 6) {
        return Err(invalid_lookup(
            hostname,
            format!("invalid address family {family}"),
        ));
    }
    if hints & !DNS_HINTS != 0 {
        return Err(invalid_lookup(
            hostname,
            format!("invalid resolver hints {hints}"),
        ));
    }
    if hostname.as_bytes().contains(&0) {
        return Err(invalid_lookup(hostname, "hostname contains NUL"));
    }
    Ok(())
}

fn invalid_lookup(hostname: &str, message: impl Into<String>) -> ErrorInfo {
    ErrorInfo::new("TypeError", message, Some("EINVAL"))
        .with_syscall("getaddrinfo")
        .with_hostname(hostname)
}

fn publish(shared: Arc<LookupShared>, hostname: &str, family: i32, hints: i32) {
    let outcome = resolve(hostname, family, hints);
    let mut state = shared.state.lock().unwrap();
    if state.cancelled || state.outcome.is_some() {
        return;
    }
    state.outcome = Some(outcome);
    drop(state);
    shared.notify.bump();
}

fn resolve(hostname: &str, family: i32, hints: i32) -> Result<Vec<u8>, ErrorInfo> {
    let node =
        CString::new(hostname).map_err(|_| invalid_lookup(hostname, "hostname contains NUL"))?;
    let libc_hints = libc_hints(hints, hostname)?;
    let mut hints = unsafe { std::mem::zeroed::<libc::addrinfo>() };
    hints.ai_family = libc_family(family);
    hints.ai_socktype = libc::SOCK_STREAM;
    hints.ai_flags = libc_hints;
    let mut result = ptr::null_mut();
    let code = unsafe { libc::getaddrinfo(node.as_ptr(), ptr::null(), &hints, &mut result) };
    if code != 0 {
        let system_errno = (code == libc::EAI_SYSTEM)
            .then(|| io::Error::last_os_error().raw_os_error())
            .flatten();
        return Err(resolver_error(hostname, code, system_errno));
    }
    let result = AddrInfo(result);
    let mut addresses = Vec::new();
    let mut current = result.0;
    while !current.is_null() {
        let info = unsafe { &*current };
        if let Some(address) = socket_address(info) {
            addresses.push(address);
        }
        current = info.ai_next;
    }
    if addresses.is_empty() {
        return Err(resolver_error(hostname, libc::EAI_NONAME, None));
    }
    serde_json::to_vec(&serde_json::json!({ "addresses": addresses }))
        .map_err(|error| ErrorInfo::new("Error", error.to_string(), Some("EIO")))
}

fn libc_family(family: i32) -> libc::c_int {
    match family {
        4 => libc::AF_INET,
        6 => libc::AF_INET6,
        _ => libc::AF_UNSPEC,
    }
}

fn libc_hints(hints: i32, hostname: &str) -> Result<libc::c_int, ErrorInfo> {
    if hints & !DNS_HINTS != 0 {
        return Err(invalid_lookup(
            hostname,
            format!("invalid resolver hints {hints}"),
        ));
    }
    let mut flags = 0;
    if hints & DNS_ALL != 0 {
        flags |= libc::AI_ALL;
    }
    if hints & DNS_ADDRCONFIG != 0 {
        flags |= libc::AI_ADDRCONFIG;
    }
    if hints & DNS_V4MAPPED != 0 {
        flags |= libc::AI_V4MAPPED;
    }
    Ok(flags)
}

fn socket_address(info: &libc::addrinfo) -> Option<serde_json::Value> {
    if info.ai_addr.is_null() {
        return None;
    }
    match info.ai_family {
        libc::AF_INET if info.ai_addrlen as usize >= size_of::<libc::sockaddr_in>() => {
            let address = unsafe { *(info.ai_addr as *const libc::sockaddr_in) };
            let ip = Ipv4Addr::from(address.sin_addr.s_addr.to_be());
            Some(serde_json::json!({ "address": ip.to_string(), "family": 4 }))
        }
        libc::AF_INET6 if info.ai_addrlen as usize >= size_of::<libc::sockaddr_in6>() => {
            let address = unsafe { *(info.ai_addr as *const libc::sockaddr_in6) };
            let ip = Ipv6Addr::from(address.sin6_addr.s6_addr);
            Some(serde_json::json!({ "address": ip.to_string(), "family": 6 }))
        }
        _ => None,
    }
}

struct AddrInfo(*mut libc::addrinfo);

impl Drop for AddrInfo {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { libc::freeaddrinfo(self.0) };
        }
    }
}

fn resolver_error(hostname: &str, code: libc::c_int, system_errno: Option<i32>) -> ErrorInfo {
    let code_name = match code {
        libc::EAI_AGAIN => "EAI_AGAIN",
        libc::EAI_BADFLAGS => "EAI_BADFLAGS",
        libc::EAI_FAIL => "EAI_FAIL",
        libc::EAI_FAMILY => "EAI_FAMILY",
        libc::EAI_MEMORY => "EAI_MEMORY",
        libc::EAI_NODATA | libc::EAI_NONAME => "ENOTFOUND",
        libc::EAI_SERVICE => "EAI_SERVICE",
        libc::EAI_SOCKTYPE => "EAI_SOCKTYPE",
        libc::EAI_SYSTEM => "EAI_SYSTEM",
        libc::EAI_OVERFLOW => "EAI_OVERFLOW",
        _ => "EAI_UNKNOWN",
    };
    let detail = unsafe {
        let message = libc::gai_strerror(code);
        if message.is_null() {
            String::from("resolver failure")
        } else {
            CStr::from_ptr(message).to_string_lossy().into_owned()
        }
    };
    let message = if code_name == "ENOTFOUND" {
        format!("getaddrinfo ENOTFOUND {hostname}")
    } else {
        format!("getaddrinfo {code_name} {hostname}: {detail}")
    };
    let mut error = ErrorInfo::new("Error", message, Some(code_name))
        .with_syscall("getaddrinfo")
        .with_hostname(hostname);
    if code_name == "EAI_SYSTEM" {
        if let Some(errno) = system_errno {
            error = error.with_errno(errno);
        }
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait(lookup: &Lookup) -> super::super::Output {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = lookup.head();
            if !matches!(output, super::super::Output::Code(crate::net::AGAIN)) {
                return output;
            }
            assert!(Instant::now() < deadline, "resolver did not complete");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn real_localhost_lookup_preserves_family_and_returns_repeatable_json() {
        let lookup = Lookup::start("localhost", 6, 0, Notify::new()).unwrap();
        let first = wait(&lookup);
        let second = lookup.head();
        assert!(matches!(first, super::super::Output::Bytes(_)));
        assert!(matches!(second, super::super::Output::Bytes(_)));
        let bytes = match first {
            super::super::Output::Bytes(bytes) => bytes,
            super::super::Output::Code(code) => panic!("unexpected resolver code {code}"),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            value["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .all(|address| address["family"] == 6)
        );
    }

    #[test]
    fn missing_hostname_keeps_structured_resolver_error() {
        let lookup = Lookup::start("bun-wasm-native-dns.invalid", 0, 0, Notify::new()).unwrap();
        assert!(matches!(
            wait(&lookup),
            super::super::Output::Code(crate::net::ERROR)
        ));
        let error = lookup.error().unwrap();
        assert_eq!(error.code.as_deref(), Some("ENOTFOUND"));
        assert_eq!(error.syscall.as_deref(), Some("getaddrinfo"));
        assert_eq!(
            error.hostname.as_deref(),
            Some("bun-wasm-native-dns.invalid")
        );
    }

    #[test]
    fn resolver_errors_use_stable_symbolic_codes() {
        for (code, expected) in [
            (libc::EAI_AGAIN, "EAI_AGAIN"),
            (libc::EAI_BADFLAGS, "EAI_BADFLAGS"),
            (libc::EAI_FAIL, "EAI_FAIL"),
            (libc::EAI_FAMILY, "EAI_FAMILY"),
            (libc::EAI_MEMORY, "EAI_MEMORY"),
            (libc::EAI_NODATA, "ENOTFOUND"),
            (libc::EAI_NONAME, "ENOTFOUND"),
            (libc::EAI_SERVICE, "EAI_SERVICE"),
            (libc::EAI_SOCKTYPE, "EAI_SOCKTYPE"),
            (libc::EAI_SYSTEM, "EAI_SYSTEM"),
            (libc::EAI_OVERFLOW, "EAI_OVERFLOW"),
        ] {
            let error = resolver_error("example.test", code, None);
            assert_eq!(error.code.as_deref(), Some(expected), "libc code {code}");
        }
        assert_eq!(
            resolver_error("example.test", 12345, None).code.as_deref(),
            Some("EAI_UNKNOWN")
        );
        assert_eq!(
            resolver_error("example.test", libc::EAI_SYSTEM, Some(13)).errno,
            Some(13)
        );
    }

    #[test]
    fn cancelled_worker_discards_late_result_without_waking_poll() {
        let notify = Notify::new();
        let shared = Arc::new(LookupShared {
            state: Mutex::new(LookupState {
                outcome: None,
                cancelled: true,
            }),
            notify: notify.clone(),
        });
        let generation = notify.generation();
        publish(shared.clone(), "localhost", 0, 0);
        assert_eq!(notify.generation(), generation);
        assert!(shared.state.lock().unwrap().outcome.is_none());
    }

    #[test]
    fn cancellation_is_logical_and_does_not_wait_for_worker() {
        let lookup = Lookup::start("localhost", 0, 0, Notify::new()).unwrap();
        let started = Instant::now();
        drop(lookup);
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
