use rquickjs::{Context, Ctx, Function, Persistent, Runtime, Value, function::Func};

#[test]
fn json_private_stack_semantics() {
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|ctx| {
        ctx.eval::<(), _>("globalThis.console = { log() {} }")
            .unwrap();
        ctx.eval::<(), _>(include_str!(
            "../../../tests/fixtures/json-private-stack/index.ts"
        ))
        .unwrap();
    });
}

#[test]
fn json_property_list_semantics() {
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|ctx| {
        ctx.eval::<(), _>("globalThis.console = { log() {} }")
            .unwrap();
        ctx.eval::<(), _>(include_str!(
            "../../../tests/fixtures/json-property-list/index.ts"
        ))
        .unwrap();
    });
}

#[test]
fn json_private_stack_gc_and_allocation_failure() {
    json_gc_and_allocation_failure(
        "(() => { const value = { nested: { text: 'x'.repeat(4096) } }; return () => JSON.stringify(value, (key, item) => { collect(); return item; }); })()",
    );
}

#[test]
fn json_property_list_gc_and_allocation_failure() {
    json_gc_and_allocation_failure(
        "(() => { const value = { nested: { text: 'x'.repeat(4096) } }; const keys = ['nested', 'text']; Object.defineProperty(keys, '0', { get() { collect(); return 'nested'; } }); return () => JSON.stringify(value, keys); })()",
    );
}

fn json_gc_and_allocation_failure(script: &str) {
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    let stringify = context.with(|ctx| {
        ctx.globals()
            .set("collect", Func::from(|ctx: Ctx<'_>| ctx.run_gc()))
            .unwrap();
        let stringify: Function = ctx.eval(script).unwrap();
        Persistent::save(&ctx, stringify)
    });
    let expected: String =
        context.with(|ctx| stringify.clone().restore(&ctx).unwrap().call(()).unwrap());
    let mut refused = false;
    for margin in [0, 256, 1024, 4096, 16384] {
        let used = runtime.memory_usage().malloc_size;
        runtime.set_memory_limit(usize::try_from(used).unwrap() + margin);
        let failed = context.with(|ctx| {
            let result = stringify
                .clone()
                .restore(&ctx)
                .unwrap()
                .call::<_, Value>(());
            let _: Value = ctx.catch();
            result.is_err()
        });
        runtime.set_memory_limit(0);
        refused |= failed;
        context.with(|ctx| {
            assert_eq!(
                stringify
                    .clone()
                    .restore(&ctx)
                    .unwrap()
                    .call::<_, String>(())
                    .unwrap(),
                expected
            )
        });
    }
    assert!(refused, "at least one JSON allocation must be refused");
    runtime.run_gc();
}
