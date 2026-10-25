use std::num::NonZeroU32;
use std::rc::Rc;

include!(concat!(env!("QUICKJS_OPS_INCLUDE"), "/modules.rs"));

thread_local! {
    static TRANSPORT: ops::abi::Transport = ops::abi::Transport::default();
    static DISPATCHER: ops::Dispatcher = ops::Dispatcher::new(
        NonZeroU32::new(1).unwrap(), 0, Rc::new(|args| Ok(args.get(0).clone())),
    ).unwrap();
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
    TRANSPORT.with(|transport| {
        DISPATCHER.with(|dispatcher| transport.dispatch(dispatcher, frame) as u32)
    })
}
