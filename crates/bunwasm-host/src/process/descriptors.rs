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
type Writer = Pin<Box<dyn AsyncWrite + Send + Sync>>;

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
                writer: Mutex::new(Box::into_pin(output.async_stream())),
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
        if input
            .poll_ready(&mut Context::from_waker(&waker))
            .is_pending()
        {
            return AGAIN;
        }
        match input.read(buf.len()) {
            Ok(bytes) => {
                buf[..bytes.len()].copy_from_slice(&bytes);
                bytes.len() as i32
            }
            Err(wasmtime_wasi::p2::StreamError::Closed) => 0,
            Err(_) => IO,
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
            .as_mut()
            .poll_write(&mut Context::from_waker(&waker), bytes)
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
        writer.lock().unwrap().as_mut().poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(endpoint) = self.0.upgrade() else {
            return Poll::Ready(Ok(()));
        };
        let Stream::Output { writer, .. } = &endpoint.stream else {
            return Poll::Ready(Ok(()));
        };
        writer.lock().unwrap().as_mut().poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // WASI dropping one stream does not close other descriptor references.
        Poll::Ready(Ok(()))
    }
}

pub fn get(fds: &Descriptors, fd: i32) -> Result<&Arc<Endpoint>, i32> {
    fds.get(&fd).ok_or(BADF)
}
