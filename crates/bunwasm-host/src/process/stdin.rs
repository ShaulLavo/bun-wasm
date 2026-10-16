use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use tokio::io::{AsyncRead, ReadBuf};
use wasmtime_wasi::cli::StdinStream;
use wasmtime_wasi::p2::{StreamError, StreamResult};

struct State {
    reader: Pin<Box<dyn AsyncRead + Send + Sync>>,
    bytes: VecDeque<u8>,
    closed: bool,
    error: Option<io::Error>,
}

#[derive(Clone)]
pub struct SharedInput {
    state: Arc<Mutex<State>>,
    pub terminal: bool,
}

impl SharedInput {
    pub fn new(stream: Arc<dyn StdinStream + Sync>) -> Self {
        Self {
            terminal: stream.is_terminal(),
            state: Arc::new(Mutex::new(State {
                reader: Box::into_pin(stream.async_stream()),
                bytes: VecDeque::new(),
                closed: false,
                error: None,
            })),
        }
    }

    pub fn poll_ready(&self, cx: &mut Context<'_>) -> Poll<()> {
        let mut state = self.state.lock().unwrap();
        if !state.bytes.is_empty() || state.closed {
            return Poll::Ready(());
        }
        let mut bytes = [0; 8192];
        let mut buffer = ReadBuf::new(&mut bytes);
        let result = std::task::ready!(state.reader.as_mut().poll_read(cx, &mut buffer));
        match result {
            Ok(()) => {
                state.closed = buffer.filled().is_empty();
                state.bytes.extend(buffer.filled());
            }
            Err(error) => {
                state.closed = true;
                state.error = Some(error);
            }
        }
        Poll::Ready(())
    }

    pub fn read(&self, size: usize) -> StreamResult<Bytes> {
        if size == 0 {
            return Ok(Bytes::new());
        }
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.error.take() {
            return Err(StreamError::LastOperationFailed(error.into()));
        }
        if state.bytes.is_empty() && state.closed {
            return Err(StreamError::Closed);
        }
        let count = size.min(state.bytes.len());
        Ok(Bytes::from(state.bytes.drain(..count).collect::<Vec<_>>()))
    }
}

impl AsyncRead for SharedInput {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buffer: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            std::task::ready!(self.poll_ready(cx));
            let mut state = self.state.lock().unwrap();
            if state.bytes.is_empty() && !state.closed {
                continue;
            }
            if let Some(error) = state.error.take() {
                return Poll::Ready(Err(error));
            }
            let count = buffer.remaining().min(state.bytes.len());
            for _ in 0..count {
                buffer.put_slice(&[state.bytes.pop_front().unwrap()]);
            }
            return Poll::Ready(Ok(()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::Waker;
    use wasmtime_wasi::p2::pipe::MemoryInputPipe;

    fn input() -> SharedInput {
        SharedInput::new(Arc::new(MemoryInputPipe::new(b"hello".to_vec())))
    }

    #[test]
    fn wasi_then_host_read_share_buffered_bytes() {
        let mut input = input();
        let mut cx = Context::from_waker(Waker::noop());
        assert!(input.poll_ready(&mut cx).is_ready());
        assert_eq!(input.read(1).unwrap(), b"h"[..]);
        let mut bytes = [0; 4];
        let mut buffer = ReadBuf::new(&mut bytes);
        assert!(Pin::new(&mut input).poll_read(&mut cx, &mut buffer).is_ready());
        assert_eq!(buffer.filled(), b"ello");
    }

    #[test]
    fn host_then_wasi_read_share_buffered_bytes() {
        let mut input = input();
        let mut cx = Context::from_waker(Waker::noop());
        let mut bytes = [0; 1];
        let mut buffer = ReadBuf::new(&mut bytes);
        assert!(Pin::new(&mut input).poll_read(&mut cx, &mut buffer).is_ready());
        assert_eq!(buffer.filled(), b"h");
        assert_eq!(input.read(4).unwrap(), b"ello"[..]);
        assert!(input.poll_ready(&mut cx).is_ready());
        assert!(matches!(input.read(1), Err(StreamError::Closed)));
    }

    #[test]
    fn zero_length_read_returns_empty() {
        let input = input();
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(input.poll_ready(&mut cx), Poll::Ready(()));
        assert_eq!(input.read(0).unwrap(), b""[..]);
    }

    #[test]
    fn zero_length_read_after_eof_is_successful() {
        let input = input();
        let mut cx = Context::from_waker(Waker::noop());
        assert!(input.poll_ready(&mut cx).is_ready());
        assert_eq!(input.read(5).unwrap(), b"hello"[..]);
        assert!(input.poll_ready(&mut cx).is_ready());
        assert_eq!(input.read(0).unwrap(), b""[..]);
    }
}
