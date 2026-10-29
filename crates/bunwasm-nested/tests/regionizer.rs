mod common;

use bunwasm_nested::{CompileErrorKind, regionize};
use common::{BASE, Outcome, PAGE, Pair, Run, engine, setup};
use wasmtime::{Linker, Module, Store, Val};

#[test]
fn empty_and_memory_only_modules_synthesize_sections() {
    let engine = engine();
    for text in [
        "(module)",
        "(module (memory (export \"memory\") 1))",
        "(module (memory (export \"memory\") 1) (data (i32.const 3) \"abc\"))",
    ] {
        let bytes = wat::parse_str(text).unwrap();
        let pair = Pair::new(&engine, &bytes).unwrap();
        assert_eq!(pair.native.region_bytes(), pair.region.region_bytes());
        pair.region.assert_sentinels();
    }
}

#[test]
fn active_data_preflight_prevents_partial_initialization() {
    let engine = engine();
    let bytes = wat::parse_str("(module (memory (export \"memory\") 1) (data (i32.const 0) \"abc\") (data (i32.const 65535) \"bad\"))").unwrap();
    assert!(Run::new(&engine, &bytes, false).is_err());
    let compiled = regionize(&bytes).unwrap();
    let plan = compiled.memory.as_ref().unwrap();
    let mut store = Store::new(
        &engine,
        common::State {
            length: PAGE,
            maximum: 2 * PAGE,
            refreshes: 0,
            calls: Vec::new(),
            memory: None,
            shared: false,
        },
    );
    store.set_fuel(100_000).unwrap();
    let mut linker = Linker::new(&engine);
    let memory = setup(&mut linker, &mut store, Some(plan)).unwrap().unwrap();
    let before = memory.read(&store);
    let module = Module::new(&engine, &compiled.bytes).unwrap();
    assert!(linker.instantiate(&mut store, &module).is_err());
    assert_eq!(before, memory.read(&store));
}

#[test]
fn original_start_and_function_global_table_indices_survive() {
    let bytes = wat::parse_str(
        "(module
        (type (func (result i32)))
        (memory (export \"memory\") 1)
        (global $value (mut i32) (i32.const 0))
        (table 1 funcref) (elem (i32.const 0) $get)
        (data (i32.const 7) \"Z\")
        (func $start i32.const 7 i32.load8_u global.set $value)
        (start $start)
        (func $get (type 0) global.get $value)
        (func (export \"run\") (result i32) i32.const 0 call_indirect (type 0)))",
    )
    .unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    assert_eq!(
        pair.call("run", &[]),
        Outcome::Values(vec!["i32:90".into()])
    );
}

#[test]
fn bulk_checks_all_ranges_and_keeps_overlap_and_zero_length_semantics() {
    let bytes = wat::parse_str("(module
        (memory (export \"memory\") 1 2)
        (data (i32.const 0) \"abcdef\") (data $p \"12345\")
        (func (export \"copy\") (param i32 i32 i32) local.get 0 local.get 1 local.get 2 memory.copy)
        (func (export \"fill\") (param i32 i32 i32) local.get 0 local.get 1 local.get 2 memory.fill)
        (func (export \"init\") (param i32 i32 i32) local.get 0 local.get 1 local.get 2 memory.init $p)
        (func (export \"drop\") data.drop $p)
        (func (export \"active\") (param i32) i32.const 0 i32.const 0 local.get 0 memory.init 0))").unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    for name in ["copy", "fill", "init"] {
        for params in [
            [1, 0, 5],
            [65535, 0, 2],
            [0, 65535, 2],
            [65536, 0, 0],
            [65537, 0, 0],
            [-1, 0, 1],
            [0, -1, 1],
            [0, 0, -1],
        ] {
            pair.call(name, &params.map(Val::I32));
        }
    }
    pair.call("active", &[Val::I32(0)]);
    pair.call("active", &[Val::I32(1)]);
    pair.call("drop", &[]);
    pair.call("init", &[Val::I32(0), Val::I32(0), Val::I32(0)]);
    pair.call("init", &[Val::I32(0), Val::I32(0), Val::I32(1)]);
}

#[test]
fn grow_size_and_cache_refresh_respect_region_limits() {
    let bytes = wat::parse_str(
        "(module (memory (export \"memory\") 1 2 shared)
        (func (export \"grow\") (param i32) (result i32) local.get 0 memory.grow)
        (func (export \"size\") (result i32) memory.size)
        (func (export \"read\") (param i32) (result i32) local.get 0 i32.load8_u))",
    )
    .unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    pair.call("read", &[Val::I32(0)]);
    assert_eq!(pair.region.store.data().refreshes, 0);
    pair.call("grow", &[Val::I32(0)]);
    pair.call("grow", &[Val::I32(1)]);
    pair.call("size", &[]);
    pair.call("read", &[Val::I32(65536)]);
    assert_eq!(pair.region.store.data().refreshes, 1);
    pair.call("read", &[Val::I32(65537)]);
    assert_eq!(pair.region.store.data().refreshes, 1);
    pair.call("grow", &[Val::I32(1)]);
    pair.call("grow", &[Val::I32(-1)]);
    pair.call("read", &[Val::I32(131072)]);
    assert_eq!(pair.region.store.data().refreshes, 2);
}

#[test]
fn wait_notify_imports_receive_effective_address_and_trap_before_dispatch() {
    let bytes = wat::parse_str("(module (memory (export \"memory\") 1 2 shared)
        (func (export \"wait32\") (param i32) (result i32) local.get 0 i32.const 0 i64.const 0 memory.atomic.wait32 offset=4)
        (func (export \"wait64\") (param i32) (result i32) local.get 0 i64.const 0 i64.const 0 memory.atomic.wait64 offset=8)
        (func (export \"notify\") (param i32) (result i32) local.get 0 i32.const 3 memory.atomic.notify offset=4))").unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    for name in ["wait32", "wait64", "notify"] {
        pair.call(name, &[Val::I32(0)]);
        let count = pair.region.store.data().calls.len();
        pair.call(name, &[Val::I32(1)]);
        pair.call(name, &[Val::I32(65536)]);
        assert_eq!(pair.region.store.data().calls.len(), count);
    }
    let calls = &pair.region.store.data().calls;
    assert_eq!(calls[0], (4, (BASE + 4) as u32, 0, 0));
    assert_eq!(calls[1], (8, (BASE + 8) as u32, 0, 0));
    assert_eq!(calls[2], (0, (BASE + 4) as u32, 3, 0));
    let result = regionize(&bytes).unwrap();
    for payload in wasmparser::Parser::new(0).parse_all(&result.bytes) {
        assert_no_native_wait(payload.unwrap());
    }
}

fn assert_no_native_wait(payload: wasmparser::Payload<'_>) {
    let wasmparser::Payload::CodeSectionEntry(body) = payload else {
        return;
    };
    for op in body.get_operators_reader().unwrap() {
        assert!(!matches!(
            op.unwrap(),
            wasmparser::Operator::MemoryAtomicWait32 { .. }
                | wasmparser::Operator::MemoryAtomicWait64 { .. }
                | wasmparser::Operator::MemoryAtomicNotify { .. }
        ));
    }
}

#[test]
fn unsupported_inputs_fail_with_structured_errors() {
    let inputs = [
        "(module (memory i64 1))",
        "(module (memory 1) (memory 1))",
        "(module (import \"env\" \"table\" (table 1 funcref)))",
        "(module (import \"env\" \"g\" (global (mut i32))))",
        "(module (import \"env\" \"g\" (global externref)))",
        "(module (import \"bunwasm_region\" \"length\" (func)))",
        "(module (tag (param i32)))",
        "(module (memory 1) (data (i32.add (i32.const 0) (i32.const 1)) \"x\"))",
        "(module (func (param v128 v128) (result v128) local.get 0 local.get 1 i8x16.relaxed_swizzle))",
    ];
    for input in inputs {
        let bytes = wat::parse_str(input).unwrap();
        let error = regionize(&bytes).unwrap_err();
        assert_eq!(
            error.kind,
            CompileErrorKind::Unsupported,
            "{input}: {error}"
        );
    }
    assert_eq!(
        regionize(b"invalid").unwrap_err().kind,
        CompileErrorKind::InvalidInput
    );
}

#[test]
fn scalar_input_stays_valid_without_simd() {
    let bytes = wat::parse_str(
        "(module (memory 1) (func (param i32 i32) local.get 0 local.get 1 i32.store))",
    )
    .unwrap();
    let result = regionize(&bytes).unwrap();
    let features = wasmparser::WasmFeatures::WASM2.difference(wasmparser::WasmFeatures::SIMD);
    wasmparser::Validator::new_with_features(features)
        .validate_all(&result.bytes)
        .unwrap();
}

#[test]
fn defined_and_imported_memory_share_one_canonical_output_contract() {
    let bytes = wat::parse_str(
        "(module (import \"env\" \"source\" (memory 1 2 shared)) (export \"memory\" (memory 0)))",
    )
    .unwrap();
    let result = regionize(&bytes).unwrap();
    let plan = result.memory.unwrap();
    assert_eq!(plan.initial_pages, 1);
    assert_eq!(plan.maximum_pages, Some(2));
    assert!(plan.shared);
    assert_eq!(plan.original_import.unwrap().name, "source");
    let mut memories = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(&result.bytes) {
        collect_memory_imports(payload.unwrap(), &mut memories);
    }
    assert_eq!(
        memories,
        vec![("bunwasm_region".to_owned(), "memory".to_owned())]
    );
}

fn collect_memory_imports(payload: wasmparser::Payload<'_>, memories: &mut Vec<(String, String)>) {
    let wasmparser::Payload::ImportSection(section) = payload else {
        return;
    };
    for import in section {
        let import = import.unwrap();
        if matches!(import.ty, wasmparser::TypeRef::Memory(_)) {
            memories.push((import.module.to_owned(), import.name.to_owned()));
        }
    }
}

#[test]
fn imported_globals_data_offsets_and_function_import_indices_survive() {
    let bytes = wat::parse_str("(module
        (import \"env\" \"offset\" (global $offset i32))
        (import \"env\" \"host\" (func $host (result i32)))
        (memory (export \"memory\") 1)
        (global $saved (mut i32) (i32.const 0))
        (data (global.get $offset) \"Z\")
        (func $start global.get $offset i32.load8_u global.set $saved) (start $start)
        (func (export \"run\") (result i32) global.get $saved call $host i32.add global.get $offset i32.add))").unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    assert_eq!(
        pair.call("run", &[]),
        Outcome::Values(vec!["i32:110".into()])
    );
}

#[test]
fn input_type_validation_precedes_rewrite_indexing() {
    for input in [
        "(module (func (type 99)))",
        "(module (memory 1) (func i32.load drop))",
        "(module (func (result i32) i64.const 0))",
    ] {
        let bytes = wat::parse_str(input).unwrap();
        assert_eq!(
            regionize(&bytes).unwrap_err().kind,
            CompileErrorKind::InvalidInput
        );
    }
}

#[test]
fn memoryless_original_start_is_preserved() {
    let bytes = wat::parse_str(
        "(module
        (import \"env\" \"host\" (func $host (result i32)))
        (global $value (mut i32) (i32.const 0))
        (func $start call $host global.set $value) (start $start)
        (func (export \"run\") (result i32) global.get $value))",
    )
    .unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    assert_eq!(
        pair.call("run", &[]),
        Outcome::Values(vec!["i32:17".into()])
    );
}

#[test]
fn plain_memory_wait_traps_and_notify_returns_zero() {
    let bytes = wat::parse_str("(module (memory (export \"memory\") 1 2)
        (func (export \"wait\") (result i32) i32.const 0 i32.const 0 i64.const 0 memory.atomic.wait32)
        (func (export \"notify\") (result i32) i32.const 0 i32.const 1 memory.atomic.notify))").unwrap();
    let mut pair = Pair::new(&engine(), &bytes).unwrap();
    assert_eq!(pair.call("wait", &[]), Outcome::Trap);
    assert_eq!(
        pair.call("notify", &[]),
        Outcome::Values(vec!["i32:0".into()])
    );
}
