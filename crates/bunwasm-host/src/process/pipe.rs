use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasmtime_wasi::cli::{IsTerminal, StdinStream, StdoutStream};

use crate::net::{AGAIN, Notify};

const CAPACITY: usize = 1 << 20;

#[derive(Default)]
struct State {
    bytes: VecDeque<u8>,
    eof: bool,
    reader_closed: bool,
    reader: Option<Waker>,
    writer: Option<Waker>,
}

#[derive(Clone)]
pub struct Pipe {
    state: Arc<Mutex<State>>,
    notify: Arc<Notify>,
}

impl Pipe {
    pub fn new(notify: Arc<Notify>) -> Self {
        Self {
            state: Arc::default(),
            notify,
        }
    }

    pub fn read(&self, buf: &mut [u8]) -> i32 {
        let mut state = self.state.lock().unwrap();
        if state.bytes.is_empty() && !state.eof {
            return AGAIN;
        }
        let count = buf.len().min(state.bytes.len());
        for byte in &mut buf[..count] {
            *byte = state.bytes.pop_front().unwrap();
        }
        if let Some(waker) = state.writer.take() {
            waker.wake();
        }
        count as i32
    }

    pub fn write(&self, bytes: &[u8]) -> i32 {
        let mut state = self.state.lock().unwrap();
        if state.reader_closed || state.eof {
            return -1;
        }
        let count = bytes.len().min(CAPACITY - state.bytes.len());
        if count == 0 && !bytes.is_empty() {
            return AGAIN;
        }
        state.bytes.extend(&bytes[..count]);
        if let Some(waker) = state.reader.take() {
            waker.wake();
        }
        self.notify.bump();
        count as i32
    }

    pub fn close_writer(&self) {
        let mut state = self.state.lock().unwrap();
        state.eof = true;
        if let Some(waker) = state.reader.take() {
            waker.wake();
        }
        self.notify.bump();
    }

    pub fn close_reader(&self) {
        let mut state = self.state.lock().unwrap();
        state.reader_closed = true;
        state.bytes.clear();
        if let Some(waker) = state.writer.take() {
            waker.wake();
        }
        self.notify.bump();
    }
}

impl IsTerminal for Pipe {
    fn is_terminal(&self) -> bool {
        false
    }
}
impl StdinStream for Pipe {
    fn async_stream(&self) -> Box<dyn AsyncRead + Send + Sync> {
        Box::new(self.clone())
    }
}
impl StdoutStream for Pipe {
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(self.clone())
    }
}

impl AsyncRead for Pipe {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let mut state = self.state.lock().unwrap();
        if state.bytes.is_empty() && !state.eof {
            state.reader = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let count = buf.remaining().min(state.bytes.len());
        for _ in 0..count {
            buf.put_slice(&[state.bytes.pop_front().unwrap()]);
        }
        if let Some(waker) = state.writer.take() {
            waker.wake();
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for Pipe {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>> {
        let mut state = self.state.lock().unwrap();
        if state.reader_closed || state.eof {
            return Poll::Ready(Err(io::Error::from_raw_os_error(libc::EPIPE)));
        }
        let count = bytes.len().min(CAPACITY - state.bytes.len());
        if count == 0 && !bytes.is_empty() {
            state.writer = Some(cx.waker().clone());
            return Poll::Pending;
        }
        state.bytes.extend(&bytes[..count]);
        if let Some(waker) = state.reader.take() {
            waker.wake();
        }
        self.notify.bump();
        Poll::Ready(Ok(count))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.close_writer();
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime_wasi::p2::bindings::filesystem::types::ErrorCode;

    #[test]
    fn closed_pipe_keeps_wasi_epipe() {
        let mut pipe = Pipe::new(crate::net::Net::new().notify());
        pipe.close_reader();
        let mut context = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(error)) = Pin::new(&mut pipe).poll_write(&mut context, b"output") else {
            panic!("closed pipe did not reject a write");
        };
        assert!(matches!(ErrorCode::from(error), ErrorCode::Pipe));
    }
}
