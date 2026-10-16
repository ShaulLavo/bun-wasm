use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasmtime_wasi::cli::{IsTerminal, StdinStream, StdoutStream};
use wasmtime_wasi::p2::{InputStream, OutputStream, Pollable, StreamError, StreamResult};
use bytes::Bytes;
use super::stdin::SharedInput;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FinalOutcome {
    Exit(i32),
    Signal(i32),
}

impl FinalOutcome {
    pub fn code(self) -> i32 {
        match self {
            Self::Exit(code) => code,
            Self::Signal(signal) => 128 + signal,
        }
    }

    pub fn signal(self) -> i32 {
        match self {
            Self::Exit(_) => 0,
            Self::Signal(signal) => signal,
        }
    }
}

#[derive(Default)]
pub struct Cancellation {
    signal: AtomicI32,
    selected: Mutex<Option<FinalOutcome>>,
    wakers: Mutex<Vec<Waker>>,
}

impl Cancellation {
    pub fn kill(&self, signal: i32) -> bool {
        {
            let mut selected = self.selected.lock().unwrap();
            if selected.is_some() {
                return false;
            }
            if signal == 0 {
                return true;
            }
            if signal == 9 {
                // KILL is unconditional, even if an earlier request is unobserved.
                *selected = Some(FinalOutcome::Signal(9));
                self.signal.store(9, Ordering::SeqCst);
            } else {
                let _ = self
                    .signal
                    .compare_exchange(0, signal, Ordering::SeqCst, Ordering::SeqCst);
            }
        }
        for waker in self.wakers.lock().unwrap().drain(..) {
            waker.wake();
        }
        true
    }

    /// Catchable requests select signal death only when actually observed.
    /// An unobserved request must not relabel an otherwise ordinary exit.
    pub fn check(&self) -> io::Result<()> {
        if self.signal.load(Ordering::SeqCst) == 0 {
            return Ok(());
        }
        let mut selected = self.selected.lock().unwrap();
        let outcome = selected.get_or_insert_with(|| {
            FinalOutcome::Signal(self.signal.load(Ordering::SeqCst))
        });
        match outcome {
            FinalOutcome::Exit(_) => Ok(()),
            FinalOutcome::Signal(_) => Err(io::ErrorKind::Interrupted.into()),
        }
    }

    /// Selection precedes pipe teardown; publication to child_wait comes later.
    pub fn select(&self, outcome: FinalOutcome) -> FinalOutcome {
        *self.selected.lock().unwrap().get_or_insert(outcome)
    }

    fn poll(&self, cx: &Context<'_>) -> io::Result<()> {
        let mut wakers = self.wakers.lock().unwrap();
        self.check()?;
        if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
            wakers.push(cx.waker().clone());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Stdio {
    pub stdin: SharedInput,
    pub stdout: Arc<dyn StdoutStream + Sync>,
    pub stderr: Arc<dyn StdoutStream + Sync>,
}

impl Stdio {
    pub fn inherited() -> Self {
        Self {
            stdin: SharedInput::new(Arc::new(wasmtime_wasi::cli::stdin())),
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
    stream: SharedInput,
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
struct OutputHandle {
    stream: Box<dyn OutputStream>,
    cancel: Arc<Cancellation>,
}

impl IsTerminal for Input {
    fn is_terminal(&self) -> bool {
        self.stream.terminal
    }
}
impl IsTerminal for Output {
    fn is_terminal(&self) -> bool {
        self.stream.is_terminal()
    }
}
impl StdinStream for Input {
    fn p2_stream(&self) -> Box<dyn InputStream> {
        Box::new(Self { stream: self.stream.clone(), cancel: self.cancel.clone() })
    }
    fn async_stream(&self) -> Box<dyn AsyncRead + Send + Sync> {
        Box::new(Reader {
            stream: Box::pin(self.stream.clone()),
            cancel: self.cancel.clone(),
        })
    }
}
#[async_trait::async_trait]
impl Pollable for Input {
    async fn ready(&mut self) {
        std::future::poll_fn(|cx| {
            if self.cancel.poll(cx).is_err() {
                return Poll::Ready(());
            }
            self.stream.poll_ready(cx)
        }).await;
    }
}

#[async_trait::async_trait]
impl InputStream for Input {
    fn read(&mut self, size: usize) -> StreamResult<Bytes> {
        self.cancel.check().map_err(|error| StreamError::LastOperationFailed(error.into()))?;
        self.stream.read(size)
    }
}

impl StdoutStream for Output {
    fn p2_stream(&self) -> Box<dyn OutputStream> {
        Box::new(OutputHandle {
            stream: self.stream.p2_stream(),
            cancel: self.cancel.clone(),
        })
    }
    fn async_stream(&self) -> Box<dyn AsyncWrite + Send + Sync> {
        Box::new(Writer {
            stream: self.stream.async_stream().into(),
            cancel: self.cancel.clone(),
        })
    }
}

#[async_trait::async_trait]
impl Pollable for OutputHandle {
    async fn ready(&mut self) {
        let mut ready = std::pin::pin!(self.stream.ready());
        std::future::poll_fn(|cx| {
            if self.cancel.poll(cx).is_err() {
                return Poll::Ready(());
            }
            ready.as_mut().poll(cx)
        }).await;
    }
}

#[async_trait::async_trait]
impl OutputStream for OutputHandle {
    fn write(&mut self, bytes: Bytes) -> StreamResult<()> {
        self.cancel.check().map_err(|error| StreamError::LastOperationFailed(error.into()))?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> StreamResult<()> {
        self.cancel.check().map_err(|error| StreamError::LastOperationFailed(error.into()))?;
        self.stream.flush()
    }
    fn check_write(&mut self) -> StreamResult<usize> {
        self.cancel.check().map_err(|error| StreamError::LastOperationFailed(error.into()))?;
        self.stream.check_write()
    }
    async fn cancel(&mut self) {
        self.stream.cancel().await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_term_does_not_relabel_ordinary_exit_143() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(15));
        assert_eq!(cancel.select(FinalOutcome::Exit(143)), FinalOutcome::Exit(143));
        assert!(!cancel.kill(9));
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.select(FinalOutcome::Signal(9)), FinalOutcome::Exit(143));
    }

    #[test]
    fn observed_term_keeps_signal_kind_when_guest_returns_an_exit() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(15));
        assert_eq!(cancel.check().unwrap_err().kind(), io::ErrorKind::Interrupted);
        let outcome = cancel.select(FinalOutcome::Exit(1));
        assert_eq!(outcome, FinalOutcome::Signal(15));
        assert_eq!(outcome.code(), 143);
        assert_eq!(outcome.signal(), 15);
        assert!(!cancel.kill(9));
    }

    #[test]
    fn kill_seals_signal_death_before_guest_exit_and_supersedes_pending_term() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(15));
        assert!(cancel.kill(9));
        assert_eq!(cancel.select(FinalOutcome::Exit(143)), FinalOutcome::Signal(9));
        assert_eq!(cancel.check().unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(!cancel.kill(15));
    }

    #[test]
    fn probe_does_not_interrupt_or_select_a_running_child() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(0));
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Exit(0));
        assert!(!cancel.kill(0));
    }

    #[test]
    fn requested_signal_wakes_a_registered_io_waiter() {
        use std::sync::atomic::AtomicUsize;
        use std::task::Wake;
        struct Counter(AtomicUsize);
        impl Wake for Counter {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let counter = Arc::new(Counter(AtomicUsize::new(0)));
        let waker = Waker::from(counter.clone());
        let cx = Context::from_waker(&waker);
        let cancel = Cancellation::default();
        assert!(cancel.poll(&cx).is_ok());
        assert!(cancel.kill(15));
        assert_eq!(counter.0.load(Ordering::SeqCst), 1);
        assert_eq!(cancel.poll(&cx).unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert_eq!(cancel.select(FinalOutcome::Exit(1)), FinalOutcome::Signal(15));
    }

    #[test]
    fn kill_and_completion_arbitrate_once() {
        for _ in 0..32 {
            let cancel = Arc::new(Cancellation::default());
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let killer = cancel.clone();
            let start = barrier.clone();
            let thread = std::thread::spawn(move || {
                start.wait();
                killer.kill(9)
            });
            barrier.wait();
            let outcome = cancel.select(FinalOutcome::Exit(143));
            let killed = thread.join().unwrap();
            assert_eq!(outcome, if killed { FinalOutcome::Signal(9) } else { FinalOutcome::Exit(143) });
            assert!(!cancel.kill(15));
            assert_eq!(cancel.select(FinalOutcome::Exit(0)), outcome);
        }
    }
}
