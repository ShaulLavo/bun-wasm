include!("../../bunwasm-engine-quickjs/src/side_modules.rs");
#[cfg(bun_wasm_shared_group)]
#[path = "../../bunwasm-engine-quickjs/src/nested_bridge.rs"]
mod nested_bridge;
mod vm;

unsafe extern "C" {
    fn bun_core_bind_engine(run: extern "C" fn(u32) -> i32);
    fn jsc_ctor_value() -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn jsc_register() {
    assert_eq!(unsafe { jsc_ctor_value() }, 42, "side constructors once");
    #[cfg(bun_wasm_shared_group)]
    unsafe {
        unsafe extern "C" {
            fn bun_core_bind_nested(dispatch: extern "C" fn(u32, u32, u32) -> u32);
        }
        bun_core_bind_nested(nested_bridge::dispatch);
    }
    unsafe { bun_core_bind_engine(jsc_run) };
}

#[unsafe(no_mangle)]
pub extern "C" fn jsc_run(session: u32) -> i32 {
    assert_eq!(unsafe { jsc_ctor_value() }, 42, "side constructors once");
    // JSC scans the stack conservatively up to its origin. A group side has no
    // linker stack symbols, so the outermost frame that can hold a value supplies it.
    #[cfg(bun_wasm_shared_group)]
    let frame = [0u8; 16];
    #[cfg(bun_wasm_shared_group)]
    vm::record_stack_origin(&frame);
    driver::run::<vm::Jsc>(session)
}
