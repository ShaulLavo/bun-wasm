use std::cell::Cell;
use std::io::Write;
use std::time::{Duration, Instant};

thread_local! {
    static ENABLED: bool = std::env::var_os("BUN_WASM_MEASURE_RUNTIME_JS")
        .is_some_and(|value| value == "1");
    static CURRENT: Cell<u64> = const { Cell::new(0) };
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

/// Inclusive wall scopes, never parse-only measurements. No source text or
/// per-module history is retained. Parent ids let consumers avoid adding a
/// bootstrap scope to the source/eval scopes nested inside it.
pub(super) fn measure<T, E>(
    engine: &str,
    stage: &str,
    module: &str,
    bytes: usize,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    measured(
        ENABLED.with(|enabled| *enabled),
        operation,
        Instant::now,
        |span, result| {
            let status = if result.is_ok() { "ok" } else { "error" };
            let _ = writeln!(
                std::io::stderr().lock(),
                "[bunwasm:runtime-js] engine={engine} stage={stage} module={module:?} bytes={bytes} id={} parent={} elapsed_ns={} status={status} scope=inclusive",
                span.id,
                span.parent,
                span.elapsed.as_nanos(),
            );
        },
    )
}

struct Span {
    id: u64,
    parent: u64,
    elapsed: Duration,
}

impl Drop for Span {
    fn drop(&mut self) {
        CURRENT.with(|current| current.set(self.parent));
    }
}

fn measured<T>(
    enabled: bool,
    operation: impl FnOnce() -> T,
    clock: impl FnOnce() -> Instant,
    emit: impl FnOnce(&Span, &T),
) -> T {
    if !enabled {
        return operation();
    }
    let id = NEXT.with(|next| {
        let id = next
            .get()
            .checked_add(1)
            .expect("runtime measurement id exhausted");
        next.set(id);
        id
    });
    let mut span = Span {
        id,
        parent: CURRENT.with(|current| current.replace(id)),
        elapsed: Duration::ZERO,
    };
    let started = clock();
    let result = operation();
    span.elapsed = started.elapsed();
    emit(&span, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_measure_preserves_results() {
        assert_eq!(
            measure("test", "factory-eval", "fixture", 12, || Ok::<_, ()>(42)),
            Ok(42)
        );
        assert_eq!(
            measure("test", "factory-eval", "fixture", 12, || Err::<(), _>(
                "error"
            )),
            Err("error")
        );
    }

    #[test]
    fn disabled_does_not_read_clock_emit_or_enter_scope() {
        let before = CURRENT.with(Cell::get);
        let value = measured(
            false,
            || 42,
            || panic!("disabled clock"),
            |_, _| panic!("disabled emission"),
        );
        assert_eq!(value, 42);
        assert_eq!(CURRENT.with(Cell::get), before);
    }

    #[test]
    fn nested_spans_are_inclusive_and_restore_parent() {
        measured(
            true,
            || {
                let parent = CURRENT.with(Cell::get);
                measured(
                    true,
                    || Err::<(), _>("original error"),
                    Instant::now,
                    |span, value| {
                        assert_eq!(span.parent, parent);
                        assert_eq!(*value, Err("original error"));
                    },
                )
            },
            Instant::now,
            |span, value| {
                assert_eq!(span.parent, 0);
                assert_eq!(*value, Err("original error"));
            },
        )
        .unwrap_err();
        assert_eq!(CURRENT.with(Cell::get), 0);
    }

    #[test]
    fn panic_restores_scope_without_replacing_failure() {
        let failure = std::panic::catch_unwind(|| {
            measured(
                true,
                || panic!("operation failed"),
                Instant::now,
                |_, _| panic!("unexpected emission"),
            );
        });
        assert!(failure.is_err());
        assert_eq!(CURRENT.with(Cell::get), 0);
    }
}
