//! VM probe only, not the runtime's Engine trait or session driver.
#[path = "../../bunwasm-engine-quickjs/src/allocator.rs"]
mod allocator;
#[path = "smoke.rs"]
mod smoke;
#[global_allocator]
static ALLOCATOR: allocator::CoreAllocator = allocator::CoreAllocator;
extern "C" {
    fn bun_core_bind_engine(run: extern "C" fn(u32) -> i32);
    fn spidermonkey_ctor_value() -> u32;
}
#[no_mangle]
pub extern "C" fn spidermonkey_register() {
    assert_eq!(unsafe { spidermonkey_ctor_value() }, 42);
    unsafe { bun_core_bind_engine(spidermonkey_run) };
}
#[no_mangle]
pub extern "C" fn spidermonkey_run(_session: u32) -> i32 {
    assert_eq!(unsafe { spidermonkey_ctor_value() }, 42);
    smoke::main();
    0
}
