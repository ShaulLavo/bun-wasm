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

struct SignalState {
    selected: Option<FinalOutcome>,
    dispositions: [u8; 65],
    pending: u64,
}

impl Default for SignalState {
    fn default() -> Self {
        Self { selected: None, dispositions: [0; 65], pending: 0 }
    }
}

#[derive(Default)]
pub struct Cancellation {
    /// Only an already-selected fatal signal interrupts engine/stdio work.
    fatal: AtomicI32,
    state: Mutex<SignalState>,
    wakers: Mutex<Vec<Waker>>,
}

impl Cancellation {
    fn raise(&self, state: &mut SignalState, signal: i32) {
        match state.dispositions[signal as usize] {
            0 => {
                state.selected = Some(FinalOutcome::Signal(signal));
                state.pending = 0;
                self.fatal.store(signal, Ordering::SeqCst);
            }
            1 => {}
            2 => state.pending |= 1u64 << (signal - 1),
            _ => unreachable!(),
        }
    }

    fn wake(&self) {
        // Do not invoke arbitrary wakers while holding either state mutex.
        let wakers = std::mem::take(&mut *self.wakers.lock().unwrap());
        for waker in wakers {
            waker.wake();
        }
    }

    pub fn kill(&self, signal: i32) -> bool {
        if !(0..=64).contains(&signal) {
            return false;
        }
        {
            let mut state = self.state.lock().unwrap();
            if state.selected.is_some() {
                return false;
            }
            if signal == 0 {
                return true;
            }
            self.raise(&mut state, signal);
        }
        self.wake();
        true
    }

    /// Slot 18: publish DEFAULT/IGNORE/HANDLE (0/1/2), raise (3), or
    /// dequeue one handled signal (0, 0). SIGKILL cannot be reconfigured.
    pub fn signal(&self, signal: i32, operation: i32) -> i32 {
        if signal == 0 && operation == 0 {
            let mut state = self.state.lock().unwrap();
            if state.pending == 0 || state.selected.is_some() {
                return 0;
            }
            let signal = state.pending.trailing_zeros() + 1;
            state.pending &= !(1u64 << (signal - 1));
            return signal as i32;
        }
        if !(1..=64).contains(&signal) || !(0..=3).contains(&operation)
            || (signal == 9 && operation != 3)
        {
            return -22;
        }
        {
            let mut state = self.state.lock().unwrap();
            if state.selected.is_some() {
                return 0;
            }
            if operation == 3 {
                self.raise(&mut state, signal);
            } else {
                state.dispositions[signal as usize] = operation as u8;
                let bit = 1u64 << (signal - 1);
                if state.pending & bit != 0 && operation != 2 {
                    state.pending &= !bit;
                    if operation == 0 {
                        self.raise(&mut state, signal);
                    }
                }
            }
        }
        self.wake();
        0
    }

    /// Handled/ignored requests never become fatal merely because I/O polls.
    pub fn check(&self) -> io::Result<()> {
        if self.fatal.load(Ordering::SeqCst) == 0 {
            Ok(())
        } else {
            Err(io::ErrorKind::Interrupted.into())
        }
    }

    /// Selection precedes pipe teardown; publication to child_wait comes later.
    pub fn select(&self, outcome: FinalOutcome) -> FinalOutcome {
        let mut state = self.state.lock().unwrap();
        let selected = *state.selected.get_or_insert(outcome);
        state.pending = 0;
        if let FinalOutcome::Signal(signal) = selected {
            self.fatal.store(signal, Ordering::SeqCst);
        }
        selected
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
    fn default_int_selects_signal_death_before_guest_completion() {
        let cancel = Cancellation::default();
        assert!(cancel.kill(2));
        let outcome = cancel.select(FinalOutcome::Exit(0));
        assert_eq!(outcome, FinalOutcome::Signal(2));
        assert_eq!(outcome.code(), 130);
    }

    #[test]
    fn handled_term_does_not_relabel_ordinary_exit_143() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(15, 2), 0);
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
    fn kill_seals_signal_death_before_guest_exit_and_supersedes_handled_term() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(15, 2), 0);
        assert!(cancel.kill(15));
        assert!(cancel.kill(9));
        assert_eq!(cancel.select(FinalOutcome::Exit(143)), FinalOutcome::Signal(9));
        assert_eq!(cancel.check().unwrap_err().kind(), io::ErrorKind::Interrupted);
        assert!(!cancel.kill(15));
    }

    #[test]
    fn handled_int_is_delivered_without_replacing_the_guest_exit() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(2, 2), 0);
        assert!(cancel.kill(2));
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.signal(0, 0), 2);
        assert_eq!(cancel.signal(0, 0), 0);
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Exit(0));
    }

    #[test]
    fn removing_an_int_handler_restores_default_action() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(2, 2), 0);
        assert_eq!(cancel.signal(2, 0), 0);
        assert!(cancel.kill(2));
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Signal(2));
    }

    #[test]
    fn removing_a_handler_with_pending_delivery_takes_default_action() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(15, 2), 0);
        assert!(cancel.kill(15));
        assert_eq!(cancel.signal(15, 0), 0);
        assert_eq!(cancel.signal(0, 0), 0);
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Signal(15));
    }

    #[test]
    fn ignore_discards_pending_and_future_delivery() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(2, 2), 0);
        assert!(cancel.kill(2));
        assert_eq!(cancel.signal(2, 1), 0);
        assert!(cancel.kill(2));
        assert_eq!(cancel.signal(0, 0), 0);
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.select(FinalOutcome::Exit(7)), FinalOutcome::Exit(7));
    }

    #[test]
    fn dequeue_precedes_once_handler_removal() {
        let cancel = Cancellation::default();
        assert_eq!(cancel.signal(2, 2), 0);
        assert!(cancel.kill(2));
        assert_eq!(cancel.signal(0, 0), 2);
        assert_eq!(cancel.signal(2, 0), 0);
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Exit(0));
    }

    #[test]
    fn different_pending_signals_are_preserved_and_repeated_signals_coalesce() {
        let cancel = Cancellation::default();
        for signal in [2, 15, 64] {
            assert_eq!(cancel.signal(signal, 2), 0);
        }
        for signal in [64, 15, 2, 15, 2] {
            assert!(cancel.kill(signal));
        }
        for signal in [2, 15, 64, 0] {
            assert_eq!(cancel.signal(0, 0), signal);
        }
        assert!(cancel.check().is_ok());
    }

    #[test]
    fn raise_honors_default_ignore_handle_and_unconditional_kill() {
        for signal in [2, 13, 15] {
            for disposition in 0..=2 {
                let cancel = Cancellation::default();
                assert_eq!(cancel.signal(signal, disposition), 0);
                assert_eq!(cancel.signal(signal, 3), 0);
                assert_eq!(cancel.signal(0, 0), if disposition == 2 { signal } else { 0 });
                let expected = if disposition == 0 { FinalOutcome::Signal(signal) } else { FinalOutcome::Exit(23) };
                assert_eq!(cancel.select(FinalOutcome::Exit(23)), expected);
            }
        }
        let cancel = Cancellation::default();
        for disposition in 0..=2 {
            assert_eq!(cancel.signal(9, disposition), -22);
        }
        assert_eq!(cancel.signal(9, 3), 0);
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Signal(9));
    }

    #[test]
    fn invalid_signal_operations_do_not_change_state() {
        let cancel = Cancellation::default();
        for (signal, operation) in [(-1, 0), (65, 0), (2, -1), (2, 4), (0, 1), (0, 3)] {
            assert_eq!(cancel.signal(signal, operation), -22);
        }
        assert!(cancel.check().is_ok());
        assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Exit(0));
    }

    #[test]
    fn handler_removal_and_dequeue_arbitrate_pending_delivery_once() {
        for _ in 0..32 {
            let cancel = Arc::new(Cancellation::default());
            assert_eq!(cancel.signal(2, 2), 0);
            assert!(cancel.kill(2));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let remover = cancel.clone();
            let start = barrier.clone();
            let thread = std::thread::spawn(move || {
                start.wait();
                remover.signal(2, 0)
            });
            barrier.wait();
            let delivered = cancel.signal(0, 0);
            assert_eq!(thread.join().unwrap(), 0);
            let expected = if delivered == 2 { FinalOutcome::Exit(0) } else { FinalOutcome::Signal(2) };
            assert_eq!(cancel.select(FinalOutcome::Exit(0)), expected);
        }
    }

    #[test]
    fn ignore_and_dequeue_cannot_turn_pending_delivery_into_default_death() {
        for _ in 0..32 {
            let cancel = Arc::new(Cancellation::default());
            assert_eq!(cancel.signal(2, 2), 0);
            assert!(cancel.kill(2));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let ignorer = cancel.clone();
            let start = barrier.clone();
            let thread = std::thread::spawn(move || {
                start.wait();
                ignorer.signal(2, 1)
            });
            barrier.wait();
            assert!(matches!(cancel.signal(0, 0), 0 | 2));
            assert_eq!(thread.join().unwrap(), 0);
            assert_eq!(cancel.signal(0, 0), 0);
            assert!(cancel.check().is_ok());
            assert_eq!(cancel.select(FinalOutcome::Exit(0)), FinalOutcome::Exit(0));
        }
    }

    #[test]
    fn default_kill_and_handler_registration_share_one_disposition_boundary() {
        for _ in 0..32 {
            let cancel = Arc::new(Cancellation::default());
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let setter = cancel.clone();
            let start = barrier.clone();
            let thread = std::thread::spawn(move || {
                start.wait();
                setter.signal(2, 2)
            });
            barrier.wait();
            assert!(cancel.kill(2));
            assert_eq!(thread.join().unwrap(), 0);
            let expected = if cancel.signal(0, 0) == 2 { FinalOutcome::Exit(0) } else { FinalOutcome::Signal(2) };
            assert_eq!(cancel.select(FinalOutcome::Exit(0)), expected);
        }
    }

    #[test]
    fn late_signal_operations_cannot_relabel_a_selected_outcome() {
        for outcome in [FinalOutcome::Exit(143), FinalOutcome::Signal(2)] {
            let cancel = Cancellation::default();
            assert_eq!(cancel.select(outcome), outcome);
            for operation in 0..=3 {
                assert_eq!(cancel.signal(15, operation), 0);
            }
            assert_eq!(cancel.signal(0, 0), 0);
            assert_eq!(cancel.select(FinalOutcome::Exit(0)), outcome);
        }
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
        for disposition in [0, 2] {
            let counter = Arc::new(Counter(AtomicUsize::new(0)));
            let waker = Waker::from(counter.clone());
            let cx = Context::from_waker(&waker);
            let cancel = Cancellation::default();
            assert_eq!(cancel.signal(15, disposition), 0);
            assert!(cancel.poll(&cx).is_ok());
            assert!(cancel.kill(15));
            assert_eq!(counter.0.load(Ordering::SeqCst), 1);
            if disposition == 0 {
                assert_eq!(cancel.poll(&cx).unwrap_err().kind(), io::ErrorKind::Interrupted);
                assert_eq!(cancel.select(FinalOutcome::Exit(1)), FinalOutcome::Signal(15));
            } else {
                assert!(cancel.poll(&cx).is_ok());
                assert_eq!(cancel.signal(0, 0), 15);
                assert_eq!(cancel.select(FinalOutcome::Exit(1)), FinalOutcome::Exit(1));
            }
        }
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
