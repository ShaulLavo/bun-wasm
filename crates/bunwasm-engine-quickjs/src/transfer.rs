//! `transferArrayBuffers`: detaches a message's buffers and, for a post over a group lane,
//! moves its ports and publishes its frame in the same call.
//!
//! The call is the last thing `postMessage` does. From the first detach to its return nothing
//! here can fail, allocate, or drop the last reference to a value, so a caller that catches an
//! exception from `postMessage` has moved nothing, and one that sees it return has published
//! the whole message. Everything that can fail runs first, in order:
//!
//! 1. Admission: the buffer list and, for a lane post, the sender end and the nonce.
//! 2. The engine's detach predicate on every buffer.
//! 3. The core's `laneCommitCheck`, with the words `laneCommitStaged` gets afterward.
//!
//! `docs/bun-patches/original-adapter-group-lane.md` has the engine facts this relies on.

use std::cell::RefCell;
use std::rc::Rc;

use crate::client::CoreClient;
use crate::data::WORD_ARGS;
use crate::engine::{Engine, NativeError, Val, ValueFn};

/// The core word operations the native runs itself, by operation number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LaneCommit {
    check: u32,
    staged: u32,
}

impl LaneCommit {
    /// Found once at bootstrap in the core's word table. Only a shared-group core has them.
    pub(crate) fn find(words: &[String]) -> Option<Self> {
        let op = |name: &str| {
            let index = words.iter().position(|word| word == name)?;
            u32::try_from(index).ok()
        };
        Some(Self {
            check: op("wasm.laneCommitCheck")?,
            staged: op("wasm.laneCommitStaged")?,
        })
    }
}

// The ranges `lane.rs` gives a sender end and a commit nonce. The core applies them again.
const MAX_SLOT: f64 = 511.0;
const MAX_GENERATION: f64 = ((1u32 << 28) - 1) as f64;
const MAX_NONCE_HIGH: f64 = ((1u32 << 20) - 1) as f64;
const MAX_WORD: f64 = u32::MAX as f64;

const NOT_DETACHABLE: &str = "ArrayBuffer is not detachable";
const STALE: &str = "MessagePort changed during transfer";

/// A number with no fraction from `min` to `max`, as a word. Nothing is rounded or saturated,
/// which is what the generic word adapter would do.
fn whole(value: &Val, min: f64, max: f64) -> Option<u32> {
    match value {
        Val::Num(number) if number.fract() == 0.0 && (min..=max).contains(number) => {
            Some(*number as u32)
        }
        _ => None,
    }
}

/// The words for `laneCommitCheck` and `laneCommitStaged`, from the five arguments after the
/// buffer list: the sender end's slot, generation and side, then the nonce's two halves.
fn sender(values: &[Val]) -> Option<[u32; WORD_ARGS]> {
    let [slot, generation, side, high, low] = values else {
        return None;
    };
    let mut words = [0; WORD_ARGS];
    words[0] = whole(slot, 0.0, MAX_SLOT)?;
    words[1] = whole(generation, 1.0, MAX_GENERATION)?;
    words[2] = whole(side, 0.0, 1.0)?;
    words[3] = whole(high, 0.0, MAX_NONCE_HIGH)?;
    words[4] = whole(low, 0.0, MAX_WORD)?;
    // Zero means "no commit" and is never a nonce.
    (words[3] != 0 || words[4] != 0).then_some(words)
}

fn invalid<E: Engine>(e: &E, message: &str) -> E::Value {
    e.error_value(&NativeError::type_error(message))
}

/// Every buffer of the list, rooted. The length is read once; a missing element is read as
/// `undefined`, which the detach predicate refuses.
fn buffers<E: Engine>(e: &E, args: &[E::Value]) -> Result<Vec<E::Value>, E::Value> {
    let Some(list) = args.first() else {
        return Err(invalid(e, "Expected a buffer list"));
    };
    let length = whole(&e.to_val(&e.get(list, "length")?), 0.0, MAX_WORD)
        .ok_or_else(|| invalid(e, "Expected a buffer list"))?;
    (0..length)
        .map(|index| e.get(list, &index.to_string()))
        .collect()
}

/// The lane commit this call makes: none for a call with only a buffer list.
fn commit<E: Engine>(
    e: &E,
    args: &[E::Value],
    lane: Option<LaneCommit>,
) -> Result<Option<(LaneCommit, [u32; WORD_ARGS])>, E::Value> {
    if args.len() <= 1 {
        return Ok(None);
    }
    let values: Vec<Val> = args
        .iter()
        .skip(1)
        .take(5)
        .map(|value| e.to_val(value))
        .collect();
    let words = sender(&values).ok_or_else(|| invalid(e, "Invalid MessagePort lane commit"))?;
    let ops = lane.ok_or_else(|| invalid(e, "MessagePort lanes are not available"))?;
    Ok(Some((ops, words)))
}

/// The error a refused call throws. The caller's last statement is this call, so nothing can
/// wrap the error afterward: a lane post passes the function that makes its `DataCloneError`.
fn refusal<E: Engine>(e: &E, args: &[E::Value], message: &str) -> E::Value {
    let named = NativeError::type_error(message).named("DataCloneError");
    let Some(make) = args.get(6).filter(|make| !e.is_undefined(make)) else {
        return e.error_value(&named);
    };
    let message = e.value_from(Val::Str(message.to_owned()));
    match e.call(make, &e.undefined(), &[message]) {
        Ok(error) | Err(error) => error,
    }
}

/// `transferArrayBuffers(buffers)` and
/// `transferArrayBuffers(buffers, slot, generation, side, nonceHigh, nonceLow, makeError)`,
/// with `transferSettled()`, which releases what the last call still holds.
pub(crate) fn natives<E: Engine>(
    client: CoreClient,
    lane: Option<LaneCommit>,
) -> [(&'static str, ValueFn<E>); 2] {
    over(move |op, words| client.word(op, words), lane)
}

/// [`natives`] over any core word call, so a test can stand in for the core.
pub(crate) fn over<E: Engine>(
    word: impl Fn(u32, [u32; WORD_ARGS]) -> i64 + 'static,
    lane: Option<LaneCommit>,
) -> [(&'static str, ValueFn<E>); 2] {
    // One more reference to every value the engine's wrapper releases when this native
    // returns, so that release only lowers a count. Releasing the last reference can
    // allocate: JSC's protect table may shrink. They go at the next call or settle.
    let held: Rc<RefCell<Vec<E::Value>>> = Rc::default();
    let settled = held.clone();
    let transfer: ValueFn<E> = Rc::new(move |e: &E, args: &[E::Value]| {
        held.borrow_mut().clear();
        // The result exists before anything moves: making `undefined` allocates on JSC and
        // SpiderMonkey.
        let done = e.undefined();
        let buffers = buffers(e, args)?;
        let commit = commit(e, args, lane)?;
        hold(&held, args, &buffers, &done);
        if buffers.iter().any(|buffer| !e.is_detachable_buffer(buffer)) {
            return Err(refusal(e, args, NOT_DETACHABLE));
        }
        if commit.is_some_and(|(ops, words)| word(ops.check, words) < 0) {
            return Err(refusal(e, args, STALE));
        }
        // ---- Nothing below can fail, allocate or release a last reference. ----
        for buffer in &buffers {
            e.detach_buffer(buffer);
        }
        if let Some((ops, words)) = commit {
            word(ops.staged, words);
        }
        Ok(done)
    });
    let release: ValueFn<E> = Rc::new(move |e: &E, _: &[E::Value]| {
        settled.borrow_mut().clear();
        Ok(e.undefined())
    });
    [
        ("transferArrayBuffers", transfer),
        ("transferSettled", release),
    ]
}

fn hold<V: Clone>(held: &RefCell<Vec<V>>, args: &[V], buffers: &[V], done: &V) {
    let mut held = held.borrow_mut();
    held.reserve(args.len() + buffers.len() + 1);
    held.extend(args.iter().cloned());
    held.extend(buffers.iter().cloned());
    held.push(done.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(values: [f64; 5]) -> Vec<Val> {
        values.into_iter().map(Val::Num).collect()
    }

    #[test]
    fn a_sender_end_and_nonce_are_admitted_exactly() {
        let top = [511.0, MAX_GENERATION, 1.0, MAX_NONCE_HIGH, MAX_WORD];
        assert_eq!(
            sender(&numbers(top)),
            Some([511, (1 << 28) - 1, 1, (1 << 20) - 1, u32::MAX, 0, 0, 0])
        );
        assert_eq!(
            sender(&numbers([0.0, 1.0, 0.0, 0.0, 1.0])),
            Some([0, 1, 0, 0, 1, 0, 0, 0])
        );
        assert_eq!(
            sender(&numbers([0.0, 1.0, 0.0, 1.0, 0.0])),
            Some([0, 1, 0, 1, 0, 0, 0, 0])
        );
        // One past each limit, a zero generation and a zero nonce.
        for (index, value) in [(0, 512.0), (1, MAX_GENERATION + 1.0), (1, 0.0), (2, 2.0)] {
            let mut values = [0.0, 1.0, 0.0, 0.0, 1.0];
            values[index] = value;
            assert_eq!(sender(&numbers(values)), None, "argument {index} = {value}");
        }
        assert_eq!(
            sender(&numbers([0.0, 1.0, 0.0, MAX_NONCE_HIGH + 1.0, 0.0])),
            None
        );
        assert_eq!(sender(&numbers([0.0, 1.0, 0.0, 0.0, MAX_WORD + 1.0])), None);
        assert_eq!(
            sender(&numbers([0.0, 1.0, 0.0, 0.0, 0.0])),
            None,
            "zero is not a nonce"
        );
        // What a saturating cast would have let through.
        for value in [
            -1.0,
            0.5,
            f64::NAN,
            f64::INFINITY,
            -f64::INFINITY,
            4_294_967_296.0,
        ] {
            for index in 0..5 {
                let mut values = [0.0, 1.0, 0.0, 0.0, 1.0];
                values[index] = value;
                assert_eq!(sender(&numbers(values)), None, "argument {index} = {value}");
            }
        }
        let mut mixed = numbers([0.0, 1.0, 0.0, 0.0, 1.0]);
        mixed[2] = Val::Bool(true);
        assert_eq!(sender(&mixed), None, "a boolean is not a side");
        mixed[2] = Val::Str("1".to_owned());
        assert_eq!(sender(&mixed), None);
        assert_eq!(
            sender(&numbers([0.0, 1.0, 0.0, 0.0, 1.0])[..4]),
            None,
            "too few"
        );
    }

    #[test]
    fn the_core_operations_are_found_by_name() {
        let words = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        let table = words(&[
            "wasm.laneCreate",
            "wasm.laneCommitStaged",
            "wasm.laneCommitCheck",
        ]);
        assert_eq!(
            LaneCommit::find(&table),
            Some(LaneCommit {
                check: 2,
                staged: 1
            })
        );
        assert_eq!(LaneCommit::find(&words(&["wasm.laneCommitCheck"])), None);
        assert_eq!(LaneCommit::find(&[]), None);
    }
}
