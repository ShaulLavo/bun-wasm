include!("../../bunwasm-engine-quickjs/src/side_modules.rs");
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
    unsafe { bun_core_bind_engine(spidermonkey_run) };
}

#[unsafe(no_mangle)]
pub extern "C" fn spidermonkey_run(session: u32) -> i32 {
    assert_eq!(
        unsafe { spidermonkey_ctor_value() },
        42,
        "side constructors once"
    );
    driver::run::<vm::SpiderMonkey>(session)
}
