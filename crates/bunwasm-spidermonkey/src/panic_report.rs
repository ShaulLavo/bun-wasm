use std::fmt::{self, Write};
use std::panic::{Location, PanicHookInfo};

const CAPACITY: usize = 1024;
const FALLBACK: &[u8] = b"SpiderMonkey Rust panic (report exceeded fixed buffer)";

struct Report {
    bytes: [u8; CAPACITY],
    length: usize,
}

impl Write for Report {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let remaining = &mut self.bytes[self.length..];
        let destination = remaining.get_mut(..text.len()).ok_or(fmt::Error)?;
        destination.copy_from_slice(text.as_bytes());
        self.length += text.len();
        Ok(())
    }
}

impl Report {
    fn new() -> Self {
        Self {
            bytes: [0; CAPACITY],
            length: 0,
        }
    }

    fn format(&mut self, message: &str, location: Option<&Location<'_>>) -> fmt::Result {
        self.write_str("SpiderMonkey Rust panic")?;
        if let Some(location) = location {
            write!(
                self,
                " at {}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )?;
        }
        write!(self, ": {message}")
    }

    fn bytes(&self) -> &[u8] {
        &self.bytes[..self.length]
    }
}

pub(super) fn fatal(info: &PanicHookInfo<'_>) -> ! {
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload");
    let mut report = Report::new();
    let bytes = match report.format(message, info.location()) {
        Ok(()) => report.bytes(),
        Err(_) => FALLBACK,
    };
    unsafe { super::bunsm_host_fatal(bytes.as_ptr().cast(), bytes.len()) }
}
