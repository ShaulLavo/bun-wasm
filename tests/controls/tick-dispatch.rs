#![allow(dead_code, unexpected_cfgs)]

use std::cell::{Cell, RefCell};
use std::num::NonZeroU32;
use std::rc::Rc;

#[path = "../../crates/bunwasm-engine-quickjs/src/client.rs"]
mod client;
#[path = "../../crates/bunwasm-runtime/src/data.rs"]
mod data;
#[path = "../../crates/bunwasm-runtime/src/ops.rs"]
mod ops;
#[path = "../../crates/bunwasm-runtime/src/split_api.rs"]
mod split_api;
#[path = "../../crates/bunwasm-engine-quickjs/src/transport.rs"]
mod transport;

mod driver {
    pub(crate) enum Entry {
        File(String),
        Eval(String),
        Test(Vec<String>),
    }
}

thread_local! {
    static TRANSPORT: ops::abi::Transport = ops::abi::Transport::default();
    static DISPATCHER: RefCell<Option<ops::Dispatcher>> = const { RefCell::new(None) };
    static PENDING: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<u32> = const { Cell::new(0) };
    static FREES: Cell<u32> = const { Cell::new(0) };
    static CALLS: Cell<u32> = const { Cell::new(0) };
    static MODE: Cell<u32> = const { Cell::new(0) };
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_alloc(bytes: u32, align: u32) -> u32 {
    ALLOCS.with(|count| count.set(count.get() + 1));
    TRANSPORT.with(|transport| transport.alloc(bytes, align))
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_free(pointer: u32, bytes: u32, align: u32) {
    FREES.with(|count| count.set(count.get() + 1));
    TRANSPORT.with(|transport| {
        transport
            .free(pointer, bytes, align)
            .expect("owned allocation")
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_dispatch(frame: u32) -> u32 {
    CALLS.with(|count| count.set(count.get() + 1));
    match MODE.with(Cell::get) {
        1 => return 3,
        2 => return 2,
        3 => return 99,
        _ => {}
    }
    DISPATCHER.with(|dispatcher| {
        TRANSPORT.with(|transport| {
            transport.dispatch(dispatcher.borrow().as_ref().unwrap(), frame) as u32
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn run(probes: u32, cached: u32, mode: u32) -> u32 {
    ALLOCS.with(|count| count.set(0));
    FREES.with(|count| count.set(0));
    CALLS.with(|count| count.set(0));
    MODE.with(|value| value.set(mode));
    let function: data::DataFn = Rc::new(|args| {
        assert!(args.0.is_empty());
        Ok(PENDING.with(|pending| pending.replace(false)).into())
    });
    DISPATCHER.with(|slot| {
        *slot.borrow_mut() = ops::Dispatcher::registry(
            NonZeroU32::new(37).unwrap(),
            vec![(split_api::TAKE_TICK, function)],
        );
    });
    let client = client::CoreClient { session: 37 };
    let mut request = None;
    let mut delivered = 0;
    for index in 0..probes {
        let pending = index % 3 == 0;
        PENDING.with(|value| value.set(pending));
        let result = probe(client, &mut request, cached != 0);
        assert_eq!(result, pending);
        assert!(!PENDING.with(Cell::get));
        delivered += u32::from(result);
    }
    drop(request);
    delivered
}

fn probe(
    client: client::CoreClient,
    request: &mut Option<client::TickRequest>,
    cached: bool,
) -> bool {
    if cached {
        return client.take_tick(request);
    }
    client
        .call(split_api::TAKE_TICK, vec![])
        .expect("take nextTick")
        == data::Val::Bool(true)
}

#[unsafe(no_mangle)]
pub extern "C" fn allocations() -> u32 {
    ALLOCS.with(Cell::get)
}

#[unsafe(no_mangle)]
pub extern "C" fn frees() -> u32 {
    FREES.with(Cell::get)
}

#[unsafe(no_mangle)]
pub extern "C" fn calls() -> u32 {
    CALLS.with(Cell::get)
}
