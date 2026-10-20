//! Process descriptors share open descriptions across dup and spawn. WASI's
//! stdio adapters hold weak references, so closing the last descriptor publishes
//! EOF immediately rather than waiting for the instance's WasiCtx to be dropped.
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasmtime_wasi::cli::{IsTerminal, StdinStream, StdoutStream};

use super::{AGAIN, BADF, IO, NOTCAPABLE, PIPE, pipe::Pipe, stdin::SharedInput};
use crate::net::Notify;

pub type Descriptors = HashMap<i32, Arc<Endpoint>>;
struct Writer {
    stream: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    flushing: bool,
    error: Option<io::Error>,
}
impl Writer {
    fn flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Some(error) = self.error.take() {
            return Poll::Ready(Err(error));
        }
        let result = std::task::ready!(self.stream.as_mut().poll_flush(cx));
        self.flushing = false;
        Poll::Ready(result)
    }
    fn write(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
        if self.flushing || self.error.is_some() {
            std::task::ready!(self.flush(cx))?;
        }
        let count = std::task::ready!(self.stream.as_mut().poll_write(cx, bytes))?;
        self.flushing = true;
        // Preserve the accepted byte count even if a later flush fails. That
        // error is returned on the next operation, never by replaying bytes.
        if let Poll::Ready(Err(error)) = self.flush(cx) {
            self.error = Some(error);
        }
        Poll::Ready(Ok(count))
    }
}

enum Stream {
    Input(SharedInput),
    Output {
        writer: Mutex<Writer>,
        terminal: bool,
    },
}

pub struct Endpoint {
    stream: Stream,
    pipe: Option<Pipe>,
}

impl Endpoint {
    pub fn input(input: SharedInput, pipe: Option<Pipe>) -> Arc<Self> {
        Arc::new(Self {
            stream: Stream::Input(input),
            pipe,
        })
    }

    pub fn output(output: Arc<dyn StdoutStream + Sync>, pipe: Option<Pipe>) -> Arc<Self> {
        Arc::new(Self {
            stream: Stream::Output {
                writer: Mutex::new(Writer {
                    stream: Box::into_pin(output.async_stream()),
                    flushing: false,
                    error: None,
                }),
                terminal: output.is_terminal(),
            },
            pipe,
        })
    }

    pub fn pair(notify: Arc<Notify>) -> [Arc<Self>; 2] {
        let pipe = Pipe::new(notify);
        [
            Self::input(SharedInput::new(Arc::new(pipe.clone())), Some(pipe.clone())),
            Self::output(Arc::new(pipe.clone()), Some(pipe)),
        ]
    }

    pub fn observe(&self, notify: &Arc<Notify>) {
        if let Some(pipe) = &self.pipe {
            pipe.observe(notify);
        }
    }

    pub fn read(&self, buf: &mut [u8], notify: &Arc<Notify>) -> i32 {
        let Stream::Input(input) = &self.stream else {
            return NOTCAPABLE;
        };
        if buf.is_empty() {
            return 0;
        }
        let waker = Waker::from(notify.clone());
        let mut input = input.clone();
        let mut buffer = ReadBuf::new(buf);
        match Pin::new(&mut input).poll_read(&mut Context::from_waker(&waker), &mut buffer) {
            Poll::Pending => AGAIN,
            Poll::Ready(Ok(())) => buffer.filled().len() as i32,
            Poll::Ready(Err(_)) => IO,
        }
    }

    pub fn write(&self, bytes: &[u8], notify: &Arc<Notify>) -> i32 {
        let Stream::Output { writer, .. } = &self.stream else {
            return NOTCAPABLE;
        };
        if bytes.is_empty() {
            return 0;
        }
        let waker = Waker::from(notify.clone());
        match writer
            .lock()
            .unwrap()
            .write(&mut Context::from_waker(&waker), bytes)
        {
            Poll::Pending => AGAIN,
            Poll::Ready(Ok(count)) => count as i32,
            Poll::Ready(Err(error)) if error.kind() == io::ErrorKind::BrokenPipe => PIPE,
            Poll::Ready(Err(_)) => IO,
        }
    }

    pub fn readiness(&self, write: bool, notify: &Arc<Notify>) -> (bool, bool) {
        match (&self.stream, write) {
            (Stream::Input(input), false) => {
                let waker = Waker::from(notify.clone());
                (
                    input
                        .poll_ready(&mut Context::from_waker(&waker))
                        .is_ready(),
                    input.closed(),
                )
            }
            (Stream::Output { .. }, true) => self
                .pipe
                .as_ref()
                .map_or((true, false), Pipe::write_readiness),
            _ => (false, false),
        }
    }

    pub fn fdstat(&self) -> (bool, u64) {
        let io = match &self.stream {
            Stream::Input(_) => 1u64 << 1,
            Stream::Output { .. } => 1u64 << 6,
        };
        (self.terminal(), io | (1u64 << 27))
    }

    pub fn kind(&self) -> i32 {
        if self.pipe.is_some() {
            return 1;
        }
        if self.terminal() { 2 } else { 0 }
    }

    fn terminal(&self) -> bool {
        match &self.stream {
            Stream::Input(input) => input.terminal,
            Stream::Output { terminal, .. } => *terminal,
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        if let Some(pipe) = &self.pipe {
            match &self.stream {
                Stream::Input(_) => pipe.close_reader(),
                Stream::Output { .. } => pipe.close_writer(),
            }
        }
    }
}

#[derive(Clone)]
pub struct StdioEndpoint(pub Weak<Endpoint>);

impl StdioEndpoint {
    pub fn for_fd(fds: &Descriptors, fd: i32) -> Self {
        Self(fds.get(&fd).map(Arc::downgrade).unwrap_or_default())
    }
    pub fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<()> {
        let Some(endpoint) = self.0.upgrade() else {
            return Poll::Ready(());
        };
        match &endpoint.stream {
            Stream::Input(input) => input.poll_ready(cx),
            _ => Poll::Ready(()),
        }
    }
    pub fn read(&self, size: usize) -> wasmtime_wasi::p2::StreamResult<bytes::Bytes> {
        let endpoint = self
            .0
            .upgrade()
            .ok_or(wasmtime_wasi::p2::StreamError::Closed)?;
        match &endpoint.stream {
            Stream::Input(input) => input.read(size),
            _ => Err(wasmtime_wasi::p2::StreamError::Closed),
        }
    }
}

impl IsTerminal for StdioEndpoint {
    fn is_terminal(&self) -> bool {
        self.0.upgrade().is_some_and(|endpoint| endpoint.terminal())
    }
}

impl StdinStream for StdioEndpoint {
    fn async_stream(&self) -> Box<dyn AsyncRead + Send + Sync> {
        Box::new(self.clone())
    }
}
impl StdoutStream for StdioEndpoint {
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(self.clone())
    }
}

impl AsyncRead for StdioEndpoint {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let Some(endpoint) = self.0.upgrade() else {
            return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EBADF)));
        };
        let Stream::Input(input) = &endpoint.stream else {
            return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EBADF)));
        };
        Pin::new(&mut input.clone()).poll_read(cx, buf)
    }
}
impl AsyncWrite for StdioEndpoint {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let Some(endpoint) = self.0.upgrade() else {
            return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EBADF)));
        };
        let Stream::Output { writer, .. } = &endpoint.stream else {
            return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EBADF)));
        };
        writer.lock().unwrap().write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(endpoint) = self.0.upgrade() else {
            return Poll::Ready(Ok(()));
        };
        let Stream::Output { writer, .. } = &endpoint.stream else {
            return Poll::Ready(Ok(()));
        };
        writer.lock().unwrap().flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // WASI dropping one stream does not close other descriptor references.
        Poll::Ready(Ok(()))
    }
}

pub fn get(fds: &Descriptors, fd: i32) -> Result<&Arc<Endpoint>, i32> {
    fds.get(&fd).ok_or(BADF)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn concurrent_shared_readers_never_report_eof_while_writer_is_open() {
        let notify = crate::net::Net::new().notify();
        let [reader, writer] = Endpoint::pair(notify.clone());
        const COUNT: usize = 50_000;
        assert_eq!(writer.write(&vec![b'x'; COUNT], &notify), COUNT as i32);
        let consumed = AtomicUsize::new(0);
        let start = std::sync::Barrier::new(4);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let reader = &reader;
                let notify = &notify;
                let consumed = &consumed;
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    for _ in 0..COUNT * 4 {
                        if consumed.load(Ordering::Acquire) == COUNT {
                            return;
                        }
                        let result = reader.read(&mut [0], notify);
                        assert!(
                            result == 1 || result == AGAIN,
                            "false EOF/error with live writer: {result}"
                        );
                        if result == 1 {
                            consumed.fetch_add(1, Ordering::AcqRel);
                        } else {
                            std::thread::yield_now();
                        }
                    }
                    assert_eq!(consumed.load(Ordering::Acquire), COUNT);
                });
            }
        });
        assert_eq!(consumed.load(Ordering::Acquire), COUNT);
        assert_eq!(reader.read(&mut [0], &notify), AGAIN);
        drop(writer);
        assert_eq!(reader.read(&mut [0], &notify), 0);
    }

    struct Buffered {
        pending: Vec<u8>,
        visible: Arc<Mutex<Vec<u8>>>,
        delay: bool,
    }
    impl AsyncWrite for Buffered {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.pending.extend_from_slice(bytes);
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            if self.delay {
                self.delay = false;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            let bytes = std::mem::take(&mut self.pending);
            self.visible.lock().unwrap().extend(bytes);
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            self.poll_flush(cx)
        }
    }
    #[test]
    fn output_flushes_non_newline_prompts_and_never_replays_accepted_bytes() {
        for delay in [false, true] {
            let visible = Arc::new(Mutex::new(Vec::new()));
            let mut writer = Writer {
                stream: Box::pin(Buffered {
                    pending: Vec::new(),
                    visible: visible.clone(),
                    delay,
                }),
                flushing: false,
                error: None,
            };
            let mut cx = Context::from_waker(Waker::noop());
            assert!(matches!(
                writer.write(&mut cx, b"prompt>"),
                Poll::Ready(Ok(7))
            ));
            if !delay {
                assert_eq!(*visible.lock().unwrap(), b"prompt>");
            }
            assert!(matches!(
                writer.write(&mut cx, b"reply"),
                Poll::Ready(Ok(5))
            ));
            assert_eq!(*visible.lock().unwrap(), b"prompt>reply");
            assert!(matches!(writer.flush(&mut cx), Poll::Ready(Ok(()))));
            assert_eq!(*visible.lock().unwrap(), b"prompt>reply");
        }
    }
}
