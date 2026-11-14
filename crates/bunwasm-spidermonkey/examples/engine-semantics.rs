extern "C" {
    fn engine_semantics_main() -> i32;
}

fn main() {
    // Taking the adapter entry keeps its object, which also contains the control driver.
    std::hint::black_box(bunwasm_spidermonkey::bsm_init as *const ());
    // SAFETY: the control driver owns the single engine instance.
    std::process::exit(unsafe { engine_semantics_main() });
}
