#[path = "../../bunwasm-engine-quickjs/src/allocator.rs"]
mod allocator;
#[path = "../../bunwasm-engine-quickjs/src/client.rs"]
mod client;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/data.rs"]
mod data;
#[path = "../../bunwasm-engine-quickjs/src/driver.rs"]
mod driver;
#[allow(unused_imports, dead_code)]
#[path = "../../bunwasm-runtime/src/engine.rs"]
mod engine;
#[path = "../../bunwasm-engine-quickjs/src/loader.rs"]
mod loader;
#[path = "../../bunwasm-engine-quickjs/src/natives.rs"]
mod natives;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/ops.rs"]
mod ops;
#[path = "../../bunwasm-engine-quickjs/src/program.rs"]
mod program;
#[path = "../../bunwasm-runtime/src/split_api.rs"]
mod split_api;
#[path = "../../bunwasm-engine-quickjs/src/transport.rs"]
mod transport;
#[path = "../../bunwasm-engine-quickjs/src/value_natives.rs"]
mod value_natives;
mod vm;

use driver::{Core, Entry};

#[global_allocator]
static ALLOCATOR: allocator::CoreAllocator = allocator::CoreAllocator;

unsafe extern "C" {
    fn bun_core_bind_engine(run: extern "C" fn(u32) -> i32);
    fn hermes_ctor_value() -> u32;
}

#[unsafe(no_mangle)]
pub extern "C" fn hermes_register() {
    assert_eq!(unsafe { hermes_ctor_value() }, 42, "side constructors once");
    unsafe { bun_core_bind_engine(hermes_run) };
}

#[unsafe(no_mangle)]
pub extern "C" fn hermes_run(session: u32) -> i32 {
    assert_eq!(unsafe { hermes_ctor_value() }, 42, "side constructors once");
    driver::run::<vm::Hermes>(session)
}
