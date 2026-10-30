include!("../../bunwasm-engine-quickjs/src/side_modules.rs");
mod vm;

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
    let code = driver::run::<vm::Hermes>(session);
    unsafe { bunwasm_hermes::bh_stop_memory_telemetry() };
    code
}
