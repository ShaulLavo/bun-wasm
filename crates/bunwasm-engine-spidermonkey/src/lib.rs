include!("../../bunwasm-engine-quickjs/src/side_modules.rs");
#[cfg(bun_wasm_shared_group)]
#[path = "../../bunwasm-engine-quickjs/src/nested_bridge.rs"]
mod nested_bridge;
mod vm;

unsafe extern "C" {
    fn bun_core_bind_engine(run: extern "C" fn(u32) -> i32);
    fn spidermonkey_ctor_value() -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn spidermonkey_register() {
    assert_eq!(
        unsafe { spidermonkey_ctor_value() },
        42,
        "side constructors once"
    );
    // The host calls this initializer itself, before the core starts: the stack pointer is
    // still at the top of the stack it carved for this member.
    #[cfg(bun_wasm_shared_group)]
    let frame = [0u8; 16];
    #[cfg(bun_wasm_shared_group)]
    vm::record_stack_top(&frame);
    #[cfg(bun_wasm_shared_group)]
    unsafe {
        unsafe extern "C" {
            fn bun_core_bind_nested(dispatch: extern "C" fn(u32, u32, u32) -> u32);
        }
        bun_core_bind_nested(nested_bridge::dispatch);
    }
    unsafe { bun_core_bind_engine(spidermonkey_run) };
}

#[unsafe(no_mangle)]
pub extern "C" fn spidermonkey_run(session: u32) -> i32 {
    assert_eq!(
        unsafe { spidermonkey_ctor_value() },
        42,
        "side constructors once"
    );
    // The engine's outermost frame must lie inside the stack recorded at registration.
    #[cfg(bun_wasm_shared_group)]
    let frame = [0u8; 16];
    #[cfg(bun_wasm_shared_group)]
    vm::record_stack_origin(&frame);
    let code = driver::run::<vm::SpiderMonkey>(session);
    vm::trace_run();
    code
}
