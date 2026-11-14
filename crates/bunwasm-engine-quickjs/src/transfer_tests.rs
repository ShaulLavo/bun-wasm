use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crate::engine::{Engine, Val, ValueFn};
use crate::vm::QuickJs;
use crate::vm::tests::{InterruptHost, InterruptMode};

type V = <QuickJs as Engine>::Value;

/// One core word call: the operation and its words.
type WordCall = (u32, [u32; 8]);

/// The transfer native on the real engine, with a recording stand-in for the core.
struct Transfer {
    engine: QuickJs,
    calls: Rc<RefCell<Vec<WordCall>>>,
    /// What `laneCommitCheck` answers.
    check: Rc<Cell<i64>>,
}

const CHECK: u32 = 0;
const STAGED: u32 = 1;

impl Transfer {
    fn new() -> Self {
        use crate::value_natives::transfer;
        let engine = QuickJs::new(Rc::new(InterruptHost::new(InterruptMode::Continue)));
        let calls = Rc::new(RefCell::new(Vec::new()));
        let check = Rc::new(Cell::new(0));
        let (seen, answer) = (calls.clone(), check.clone());
        let word = move |op, words| {
            seen.borrow_mut().push((op, words));
            if op == CHECK { answer.get() } else { 0 }
        };
        let names = ["wasm.laneCommitCheck", "wasm.laneCommitStaged"].map(str::to_owned);
        let lane = transfer::LaneCommit::find(&names);
        let global = engine.eval_script("globalThis", "global", 1).unwrap();
        for (name, function) in transfer::over::<QuickJs>(word, lane) {
            let function = engine.new_function(name, function);
            engine.set(&global, name, function).unwrap();
        }
        Self {
            engine,
            calls,
            check,
        }
    }

    /// Runs `body` as a function body and returns what it returns.
    fn run(&self, body: &str) -> Val {
        let source = format!("(() => {{ {body} }})()");
        let value = self.engine.eval_script(&source, "transfer", 1);
        self.engine.to_val(&value.unwrap_or_else(|error| error))
    }

    fn calls(&self) -> Vec<WordCall> {
        self.calls.take()
    }

    /// A list of a good buffer and then `last`, which no transfer may take. A plain
    /// transfer throws its own `DataCloneError`; a lane transfer throws what the caller's
    /// maker made. Either way the good buffer keeps its bytes and the core hears nothing,
    /// since the predicate comes before the core's check.
    fn assert_bad_last_buffer_is_refused(&self, name: &str, last: &str, lane: bool) {
        let (call, expected) = if lane {
            (
                "transferArrayBuffers([good, last], 3, 7, 1, 0, 9, message => ({ made: message }))",
                ",ArrayBuffer is not detachable,8",
            )
        } else {
            ("transferArrayBuffers([good, last])", "DataCloneError,,8")
        };
        let outcome = self.run(&format!(
            "const good = new ArrayBuffer(8), last = {last};
                 try {{ {call}; return 'returned'; }}
                 catch (error) {{ return [error.name, error.made, good.byteLength].join(); }}"
        ));
        assert_eq!(outcome, text(expected), "{name}, lane {lane}");
        assert!(self.calls().is_empty(), "{name}, lane {lane}");
    }
}

fn text(value: &str) -> Val {
    Val::Str(value.to_owned())
}

#[test]
fn a_plain_transfer_detaches_every_buffer_of_the_list() {
    let transfer = Transfer::new();
    let detached = transfer.run(
        "const plain = new ArrayBuffer(8), empty = new ArrayBuffer(0);
             const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
             const viewed = new ArrayBuffer(8), view = new Uint8Array(viewed);
             const result = transferArrayBuffers([plain, empty, resizable, viewed]);
             return [result === undefined, plain.byteLength, plain.detached, empty.detached,
               resizable.detached, viewed.detached, view.length].join();",
    );
    assert_eq!(detached, text("true,0,true,true,true,true,0"));
    assert!(transfer.calls().is_empty(), "no lane, no core call");
    assert_eq!(
        transfer.run("return transferArrayBuffers([]) === undefined"),
        Val::Bool(true)
    );
    std::mem::forget(transfer);
}

#[test]
fn one_bad_buffer_leaves_every_buffer_attached() {
    let transfer = Transfer::new();
    let bad = [
        (
            "detached",
            "(() => { const b = new ArrayBuffer(1); transferArrayBuffers([b]); return b; })()",
        ),
        ("number", "5"),
        ("missing", "undefined"),
        ("view", "new Uint8Array(4)"),
        ("shared", "new SharedArrayBuffer(4)"),
        ("immutable", "new ArrayBuffer(4).sliceToImmutable()"),
    ];
    for (name, last) in bad {
        for lane in [false, true] {
            transfer.assert_bad_last_buffer_is_refused(name, last, lane);
        }
    }
    // A list whose length is not a whole number of elements is no list.
    for length in ["1.5", "-1", "NaN", "'1'", "4294967296"] {
        let outcome = transfer.run(&format!(
            "const good = new ArrayBuffer(8);
                 try {{ transferArrayBuffers({{ length: {length}, 0: good }}); return 'returned'; }}
                 catch (error) {{ return [error.name, good.byteLength].join(); }}"
        ));
        assert_eq!(outcome, text("TypeError,8"), "length {length}");
    }
    std::mem::forget(transfer);
}

#[test]
fn a_lane_transfer_checks_then_detaches_then_commits_with_the_same_words() {
    let transfer = Transfer::new();
    let outcome = transfer.run(
            "const first = new ArrayBuffer(8), second = new ArrayBuffer(8);
             const result = transferArrayBuffers([first, second], 511, 268435455, 1, 1048575, 4294967295);
             return [result === undefined, first.detached, second.detached].join();",
        );
    assert_eq!(outcome, text("true,true,true"));
    let words = [511, (1 << 28) - 1, 1, (1 << 20) - 1, u32::MAX, 0, 0, 0];
    assert_eq!(transfer.calls(), [(CHECK, words), (STAGED, words)]);
    // A message with no buffers still commits its frame and ports.
    assert_eq!(
        transfer.run("return transferArrayBuffers([], 0, 1, 0, 0, 1) === undefined"),
        Val::Bool(true)
    );
    let words = [0, 1, 0, 0, 1, 0, 0, 0];
    assert_eq!(transfer.calls(), [(CHECK, words), (STAGED, words)]);
    std::mem::forget(transfer);
}

#[test]
fn a_refused_commit_throws_the_callers_error_with_everything_attached() {
    let transfer = Transfer::new();
    transfer.check.set(-1);
    let outcome = transfer.run(
            "const buffer = new ArrayBuffer(8), thrown = new Error('made');
             let asked;
             try { transferArrayBuffers([buffer], 3, 7, 1, 0, 9, message => { asked = message; return thrown; }); }
             catch (error) { return [error === thrown, asked, buffer.byteLength].join(); }
             return 'returned';",
        );
    assert_eq!(outcome, text("true,MessagePort changed during transfer,8"));
    assert_eq!(
        transfer.calls(),
        [(CHECK, [3, 7, 1, 0, 9, 0, 0, 0])],
        "no commit followed"
    );
    // A maker that throws: its error is the one thrown, and still nothing moved.
    let outcome = transfer.run(
            "const buffer = new ArrayBuffer(8);
             try { transferArrayBuffers([buffer], 3, 7, 1, 0, 9, () => { throw new RangeError('deep'); }); }
             catch (error) { return [error.name, buffer.byteLength].join(); }
             return 'returned';",
        );
    assert_eq!(outcome, text("RangeError,8"));
    // Without a maker the refusal is still a DataCloneError by name.
    let outcome = transfer.run(
        "try { transferArrayBuffers([], 3, 7, 1, 0, 9); } catch (error) { return error.name; }
             return 'returned';",
    );
    assert_eq!(outcome, text("DataCloneError"));
    std::mem::forget(transfer);
}

#[test]
fn a_commit_word_out_of_range_is_refused_before_the_core_and_before_any_detach() {
    let transfer = Transfer::new();
    let bad = [
        "512, 7, 1, 0, 9",
        "3, 0, 1, 0, 9",
        "3, 268435456, 1, 0, 9",
        "3, 7, 2, 0, 9",
        "3, 7, 1, 1048576, 9",
        "3, 7, 1, 0, 4294967296",
        "3, 7, 1, 0, 0",
        "3.5, 7, 1, 0, 9",
        "3, 7, -1, 0, 9",
        "3, 7, 1, NaN, 9",
        "3, 7, true, 0, 9",
        "'3', 7, 1, 0, 9",
        "3, 7, 1, 0",
        "3",
    ];
    for words in bad {
        let outcome = transfer.run(&format!(
            "const buffer = new ArrayBuffer(8);
                 try {{ transferArrayBuffers([buffer], {words}); return 'returned'; }}
                 catch (error) {{ return [error.name, buffer.byteLength].join(); }}"
        ));
        assert_eq!(outcome, text("TypeError,8"), "words {words}");
        assert!(transfer.calls().is_empty(), "words {words}");
    }
    std::mem::forget(transfer);
}

/// The whole path a post must cross without failing: from the core's commit check, through
/// the detaches, the commit, the native's return, the engine wrapper's release of its
/// arguments and the JavaScript function's own return, to the caller's next statement.
/// Nothing on it asks the allocator for anything, so no allocation can fail there.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn nothing_is_allocated_from_the_commit_check_to_the_callers_next_statement() {
    use crate::allocation_probe;
    use crate::value_natives::transfer;
    let engine = QuickJs::new(Rc::new(InterruptHost::new(InterruptMode::Continue)));
    let commits = Rc::new(Cell::new(0));
    let committed = commits.clone();
    // The check is the last call that may refuse: counting starts as it returns.
    let word = move |op, _| {
        if op == CHECK {
            allocation_probe::arm();
        } else {
            committed.set(committed.get() + 1);
        }
        0
    };
    let names = ["wasm.laneCommitCheck", "wasm.laneCommitStaged"].map(str::to_owned);
    let global = engine.eval_script("globalThis", "global", 1).unwrap();
    for (name, function) in transfer::over::<QuickJs>(word, transfer::LaneCommit::find(&names)) {
        engine
            .set(&global, name, engine.new_function(name, function))
            .unwrap();
    }
    // The caller's next statement: a native that takes no arguments and stops the count.
    let seen = Rc::new(Cell::new(usize::MAX));
    let report = seen.clone();
    let stop: ValueFn<QuickJs> = Rc::new(move |e: &QuickJs, _: &[V]| {
        report.set(allocation_probe::disarm());
        Ok(e.undefined())
    });
    engine
        .set(&global, "stop", engine.new_function("stop", stop))
        .unwrap();
    // `post` ends as postMessage does, with the transfer call as its last statement. The
    // list is a temporary, so the wrapper's release of its arguments would free it if
    // the native did not hold it.
    let script = "function post(first, second, view) {
               transferArrayBuffers([first, second, view.buffer], 3, 7, 1, 0, 9);
             }
             const buffers = [new ArrayBuffer(64), new ArrayBuffer(0, { maxByteLength: 16 }), new Uint8Array(32)];
             post(buffers[0], buffers[1], buffers[2]);
             stop();
             [buffers[0].detached, buffers[1].detached, buffers[2].buffer.detached].join()";
    let detached = engine.eval_script(script, "tail", 1).unwrap();
    assert_eq!(engine.to_val(&detached), text("true,true,true"));
    assert_eq!(
        commits.get(),
        1,
        "the commit ran inside the counted stretch"
    );
    assert_eq!(
        seen.get(),
        0,
        "allocation requests between the check and the next statement"
    );
    // The count is live: the same stretch with one allocation in it is seen.
    allocation_probe::arm();
    drop(Vec::<u8>::with_capacity(64));
    assert_eq!(allocation_probe::disarm(), 1);
    // And it sees the engine's own allocations, not only Rust's.
    allocation_probe::arm();
    let strings = engine.eval_script("new Array(100).fill(1).map(String)", "probe", 1);
    assert!(allocation_probe::disarm() > 0);
    drop(strings);
    std::mem::forget(engine);
}

#[test]
fn what_a_transfer_was_given_stays_referenced_until_it_is_settled() {
    let transfer = Transfer::new();
    // The engine's wrapper releases its arguments when the native returns. One more
    // reference keeps each alive, so that release is never a last one.
    let outcome = transfer.run(
        "let list = [new ArrayBuffer(8)];
             const weak = new WeakRef(list);
             transferArrayBuffers(list, 3, 7, 1, 0, 9);
             list = null;
             const held = weak.deref() !== undefined;
             transferSettled();
             const settled = weak.deref() === undefined;
             let next = [new ArrayBuffer(8)];
             const later = new WeakRef(next);
             transferArrayBuffers(next);
             next = null;
             const again = later.deref() !== undefined;
             transferArrayBuffers([]);
             return [held, settled, again, later.deref() === undefined].join();",
    );
    assert_eq!(outcome, text("true,true,true,true"));
    std::mem::forget(transfer);
}
