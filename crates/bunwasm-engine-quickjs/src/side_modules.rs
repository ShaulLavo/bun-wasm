// The shared engine-program sources every non-QuickJS side compiles with its own `vm.rs`
// (`include!`d at the side crate's root, which declares `mod vm`; paths are relative to this file).
#[path = "allocator.rs"]
mod allocator;
#[path = "client.rs"]
mod client;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/data.rs"]
mod data;
#[path = "driver.rs"]
mod driver;
#[allow(unused_imports, dead_code)]
#[path = "../../bunwasm-runtime/src/engine.rs"]
mod engine;
#[path = "loader.rs"]
mod loader;
#[path = "natives.rs"]
mod natives;
#[allow(dead_code, unexpected_cfgs)]
#[path = "../../bunwasm-runtime/src/ops.rs"]
mod ops;
#[path = "program.rs"]
mod program;
#[path = "../../bunwasm-runtime/src/split_api.rs"]
mod split_api;
#[path = "transport.rs"]
mod transport;
#[path = "value_natives.rs"]
mod value_natives;

use driver::{Core, Entry};

#[global_allocator]
static ALLOCATOR: allocator::CoreAllocator = allocator::CoreAllocator;
