use crate::data::{Args, NativeResult, Val};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use wasmi::{CompilationMode, Config, Engine, Module};

const BODY_BYTES: usize = 13_441;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static FREES: AtomicUsize = AtomicUsize::new(0);

struct BodyAllocator;

fn record(size: usize, counter: &AtomicUsize) {
    if COUNTING.load(Relaxed) && size == BODY_BYTES {
        counter.fetch_add(1, Relaxed);
    }
}

unsafe impl GlobalAlloc for BodyAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record(layout.size(), &ALLOCS);
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record(layout.size(), &ALLOCS);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record(layout.size(), &FREES);
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, size) };
        if !result.is_null() {
            record(layout.size(), &FREES);
            record(size, &ALLOCS);
        }
        result
    }
}

// Only this single-threaded test executable installs an allocation observer.
#[global_allocator]
static ALLOCATOR: BodyAllocator = BodyAllocator;

fn measure(label: &str, expected: (usize, usize), operation: impl FnOnce()) {
    ALLOCS.store(0, Relaxed);
    FREES.store(0, Relaxed);
    COUNTING.store(true, Relaxed);
    operation();
    COUNTING.store(false, Relaxed);
    let observed = (ALLOCS.load(Relaxed), FREES.load(Relaxed));
    assert_eq!(observed, expected, "{label}");
    println!(
        "{label}: {} allocations, {} frees of {BODY_BYTES} bytes",
        observed.0, observed.1
    );
}

fn leb(mut value: usize, bytes: &mut Vec<u8>) {
    loop {
        let next = (value & 127) as u8;
        value >>= 7;
        bytes.push(next | if value > 0 { 128 } else { 0 });
        if value == 0 {
            break;
        }
    }
}

fn section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
    module.push(id);
    leb(payload.len(), module);
    module.extend_from_slice(payload);
}

fn fixture() -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[1, 0x60, 0, 1, 0x7f]);
    section(&mut module, 3, &[1, 0]);
    section(&mut module, 7, &[1, 3, b'r', b'u', b'n', 0, 0]);
    let mut code = vec![1];
    leb(BODY_BYTES, &mut code);
    code.push(0);
    code.resize(code.len() + BODY_BYTES - 4, 1);
    code.extend_from_slice(&[0x41, 42, 0x0b]);
    section(&mut module, 10, &code);
    module
}

fn dispatch(table: &natives::Table, name: &str, args: &[Val]) -> NativeResult {
    let (_, function) = table
        .functions
        .iter()
        .find(|(key, _)| *key == name)
        .unwrap();
    function(Args(args))
}

fn field(value: Val, name: &str) -> Val {
    let Val::Object(fields) = value else {
        panic!("expected record");
    };
    fields.into_iter().find(|(key, _)| key == name).unwrap().1
}

fn validation_cases() {
    let mut table = natives::Table::default();
    wasm::install(&mut table);
    let table = &table;
    let validate = |bytes: Vec<u8>| dispatch(table, "wasm.validate", &[Val::Bytes(bytes)]).unwrap();
    assert_eq!(validate(b"\0asm\x01\0\0\0".to_vec()), Val::Bool(true));
    assert_eq!(validate(b"not wasm".to_vec()), Val::Bool(false));
    let mut invalid = fixture();
    *invalid.last_mut().unwrap() = 0xff;
    assert_eq!(validate(invalid.clone()), Val::Bool(false));
    assert!(dispatch(table, "wasm.compile", &[Val::Bytes(invalid)]).is_err());
    assert!(dispatch(table, "wasm.validate", &[Val::Null]).is_err());

    // Multi-value is enabled by the runtime's default Wasmi Config; SIMD is disabled.
    let mut multi = b"\0asm\x01\0\0\0".to_vec();
    section(&mut multi, 1, &[1, 0x60, 0, 2, 0x7f, 0x7f]);
    section(&mut multi, 3, &[1, 0]);
    section(&mut multi, 10, &[1, 6, 0, 0x41, 1, 0x41, 2, 0x0b]);
    assert_eq!(validate(multi.clone()), Val::Bool(true));
    assert!(dispatch(table, "wasm.compile", &[Val::Bytes(multi)]).is_ok());
    let mut simd = b"\0asm\x01\0\0\0".to_vec();
    section(&mut simd, 1, &[1, 0x60, 1, 0x7b, 0]);
    assert_eq!(validate(simd.clone()), Val::Bool(false));
    assert!(dispatch(table, "wasm.compile", &[Val::Bytes(simd)]).is_err());
    println!(
        "runtime boundary: valid, malformed body, bad header, argument type, multi-value and SIMD passed"
    );
}

fn old_validation_control(bytes: &[u8]) {
    let mut config = Config::default();
    config.compilation_mode(CompilationMode::LazyTranslation);
    let engine = Engine::new(&config);
    measure("old validation, three calls", (3, 0), || {
        for _ in 0..3 {
            assert!(Module::new(&engine, bytes).is_ok());
        }
    });
    measure("old validation, engine drop", (0, 3), || drop(engine));
}

fn main() {
    validation_cases();
    let mut table = natives::Table::default();
    wasm::install(&mut table);
    let mut input = Val::Bytes(fixture());
    let Val::Bytes(bytes) = &input else {
        unreachable!()
    };
    old_validation_control(bytes);
    let args = std::slice::from_ref(&input);
    measure("runtime validation, three calls", (0, 0), || {
        for _ in 0..3 {
            assert_eq!(
                dispatch(&table, "wasm.validate", args).unwrap(),
                Val::Bool(true)
            );
        }
    });
    let mut module = Val::Undefined;
    measure("runtime compile", (1, 0), || {
        module = field(dispatch(&table, "wasm.compile", args).unwrap(), "id");
    });
    let Val::Bytes(bytes) = &mut input else {
        unreachable!()
    };
    bytes.fill(0);
    drop(input);
    let guest = dispatch(&table, "wasm.instantiate", &[module, Val::Array(vec![])]).unwrap();
    let function = field(
        dispatch(&table, "wasm.functionIdentity", &[guest, Val::from("run")]).unwrap(),
        "id",
    );
    measure("first call after input mutation and drop", (0, 1), || {
        let result = dispatch(&table, "wasm.call", &[function, Val::Array(vec![])]).unwrap();
        assert_eq!(field(result, "values"), Val::Array(vec![Val::Num(42.0)]));
    });
    measure("runtime drop", (0, 0), || drop(table));
}
