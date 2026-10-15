use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasmtime_wasi::cli::{IsTerminal, StdinStream, StdoutStream};

#[derive(Default)]
pub struct Cancellation {
    pub signal: AtomicI32,
    wakers: Mutex<Vec<Waker>>,
}

impl Cancellation {
    pub fn kill(&self, signal: i32) {
        let _ = self
            .signal
            .compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst);
        for waker in self.wakers.lock().unwrap().drain(..) {
            waker.wake();
        }
    }
    fn poll(&self, cx: &Context<'_>) -> io::Result<()> {
        let mut wakers = self.wakers.lock().unwrap();
        if self.signal.load(Ordering::SeqCst) != 0 {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
            wakers.push(cx.waker().clone());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Stdio {
    pub stdin: Arc<dyn StdinStream + Sync>,
    pub stdout: Arc<dyn StdoutStream + Sync>,
    pub stderr: Arc<dyn StdoutStream + Sync>,
}

impl Stdio {
    pub fn inherited() -> Self {
        Self {
            stdin: Arc::new(wasmtime_wasi::cli::stdin()),
            stdout: Arc::new(std::io::stdout()),
            stderr: Arc::new(std::io::stderr()),
        }
    }
    pub fn install(&self, wasi: &mut wasmtime_wasi::WasiCtxBuilder, cancel: Arc<Cancellation>) {
        wasi.stdin(Input {
            stream: self.stdin.clone(),
            cancel: cancel.clone(),
        });
        wasi.stdout(Output {
            stream: self.stdout.clone(),
            cancel: cancel.clone(),
        });
        wasi.stderr(Output {
            stream: self.stderr.clone(),
            cancel,
        });
    }
}

struct Input {
    stream: Arc<dyn StdinStream + Sync>,
    cancel: Arc<Cancellation>,
}
struct Output {
    stream: Arc<dyn StdoutStream + Sync>,
    cancel: Arc<Cancellation>,
}
struct Reader {
    stream: Pin<Box<dyn AsyncRead + Send + Sync>>,
    cancel: Arc<Cancellation>,
}
struct Writer {
    stream: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    cancel: Arc<Cancellation>,
}

impl IsTerminal for Input {
    fn is_terminal(&self) -> bool {
        self.stream.is_terminal()
    }
}
impl IsTerminal for Output {
    fn is_terminal(&self) -> bool {
        self.stream.is_terminal()
    }
}
impl StdinStream for Input {
    fn async_stream(&self) -> Box<dyn AsyncRead + Send + Sync> {
        Box::new(Reader {
            stream: self.stream.async_stream().into(),
            cancel: self.cancel.clone(),
        })
    }
}
impl StdoutStream for Output {
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(Writer {
            stream: self.stream.async_stream().into(),
            cancel: self.cancel.clone(),
        })
    }
}
impl AsyncRead for Reader {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.cancel.poll(cx) {
            return Poll::Ready(Err(error));
        }
        self.stream.as_mut().poll_read(cx, buf)
    }
}
impl AsyncWrite for Writer {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if let Err(error) = self.cancel.poll(cx) {
            return Poll::Ready(Err(error));
        }
        self.stream.as_mut().poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if let Err(error) = self.cancel.poll(cx) {
            return Poll::Ready(Err(error));
        }
        self.stream.as_mut().poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.stream.as_mut().poll_shutdown(cx)
    }
}
