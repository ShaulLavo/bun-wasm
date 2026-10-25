//! Process-owned data transport and the single linked engine entry.
use std::cell::{Cell, RefCell};
use std::num::NonZeroU32;
use std::rc::Rc;

use crate::{Options, State, natives, new_state, ops};

type Run = extern "C" fn(u32) -> i32;

thread_local! {
    static ENGINE: Cell<Option<Run>> = const { Cell::new(None) };
    static SESSION: RefCell<Option<Rc<ops::Dispatcher>>> = const { RefCell::new(None) };
    static TRANSPORT: ops::abi::Transport = ops::abi::Transport::default();
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_bind_engine(run: Run) {
    ENGINE.with(|entry| assert!(entry.replace(Some(run)).is_none(), "engine already bound"));
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_alloc(bytes: u32, align: u32) -> u32 {
    TRANSPORT.with(|transport| transport.alloc(bytes, align))
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_free(pointer: u32, bytes: u32, align: u32) {
    TRANSPORT.with(|transport| {
        transport
            .free(pointer, bytes, align)
            .expect("owned transport")
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_dispatch(frame: u32) -> u32 {
    let dispatcher = SESSION.with(|session| session.borrow().clone());
    let Some(dispatcher) = dispatcher else {
        return ops::Status::BadCall as u32;
    };
    TRANSPORT.with(|transport| transport.dispatch(&dispatcher, frame) as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_checkpoint() -> u32 {
    u32::from(crate::host::signal(0, 4) != 0)
}

fn stdout_dispatcher(state: &Rc<State>) -> Rc<ops::Dispatcher> {
    let (_, function) = natives::table(state)
        .functions
        .into_iter()
        .find(|(name, _)| *name == "writeStdout")
        .expect("stdout native");
    Rc::new(ops::Dispatcher::new(NonZeroU32::new(1).unwrap(), 0, function).unwrap())
}

pub(crate) fn run(options: Options) -> i32 {
    let Some(run) = ENGINE.with(Cell::get) else {
        eprintln!("QuickJS engine is not registered");
        return 1;
    };
    let (state, _) = new_state(&options.entry, &options.args, options.transpiler);
    SESSION.with(|session| assert!(session.replace(Some(stdout_dispatcher(&state))).is_none()));
    let code = run(1);
    SESSION.with(|session| session.take());
    state.directories.borrow_mut().close_all();
    state.flush();
    code
}
