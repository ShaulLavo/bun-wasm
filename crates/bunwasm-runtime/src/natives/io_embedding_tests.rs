use super::*;
use crate::engine::{Engine, ModuleHost, data_fn};
use crate::quickjs_embedding::{QuickJs, quickjs_memory_telemetry};
use rquickjs::qjs;

type Value = <QuickJs as Engine>::Value;

struct Host;

impl ModuleHost<QuickJs> for Host {
    fn uncaught(&self, _: &QuickJs, _: &Value) {
        panic!("unexpected uncaught embedding error");
    }
    fn resolve(&self, _: &QuickJs, _: &str, _: &str) -> Result<String, Value> {
        unreachable!("the embedding loads shared factories directly")
    }
    fn load(&self, _: &QuickJs, _: &str) -> Result<String, Value> {
        unreachable!("the embedding loads shared factories directly")
    }
    fn init_meta(&self, _: &QuickJs, _: &str, _: &Value) -> Result<(), Value> {
        unreachable!("the embedding loads shared factories directly")
    }
}

#[derive(Default)]
struct Reads {
    armed: Cell<bool>,
    count: Cell<usize>,
    largest: Cell<usize>,
}

impl Reads {
    fn record(&self, name: &str, args: &[Val]) {
        if name != "read" || !self.armed.get() {
            return;
        }
        let Val::Num(length) = args[1] else {
            panic!("native read length")
        };
        self.count.set(self.count.get() + 1);
        self.largest.set(self.largest.get().max(length as usize));
    }
}

fn natives(engine: &QuickJs, reads: &Rc<Reads>) -> Value {
    let (state, _) = crate::new_state(
        &crate::Entry::Eval(String::new()),
        &[],
        &[],
        &[],
        crate::RunMode::Once,
        Box::new(crate::PassthroughTranspiler),
    );
    let table = super::super::table(&state);
    let native = engine.new_object();
    for (id, (name, function)) in table.functions.into_iter().enumerate() {
        let dispatch =
            Dispatcher::new(NonZeroU32::MIN, u32::try_from(id).unwrap(), function).unwrap();
        let reads = reads.clone();
        let call = data_fn::<QuickJs>(move |args| {
            reads.record(name, &args);
            dispatch.call(args)
        });
        engine
            .set(&native, name, engine.new_function(name, call))
            .unwrap();
    }
    for (name, value) in table.constants {
        engine.set(&native, name, engine.value_from(value)).unwrap();
    }
    engine
        .set(&native, "engine", engine.value_from("quickjs".into()))
        .unwrap();
    let load = engine.new_function(
        "loadPolyfill",
        Rc::new(|engine, args| {
            let Val::Str(name) = engine.to_val(&args[0]) else {
                panic!("polyfill name")
            };
            let source = crate::modules::polyfill_source(&name).expect("shared polyfill");
            engine.eval_script(source, &format!("bun-wasm:{name}"), 1)
        }),
    );
    engine.set(&native, "loadPolyfill", load).unwrap();
    native
}

// The loader supplies the unmodified shared factories, including web.toUint8,
// Buffer and node_fs. Only timer delivery is fixture-owned.
const SETUP: &str = r#"(function(native, file, wholeCopy) {
  const pending = [];
  const modules = new Map();
  const internal = {
    native, describe: String,
    realTimers: { setImmediate(fn) { pending.push(fn); } },
    require(name) {
      if (!modules.has(name)) modules.set(name, native.loadPolyfill(name)(internal));
      return modules.get(name);
    },
  };
  const install = internal.require("web");
  install((name, value) => { globalThis[name] = value; }, () => {});
  const { Buffer } = internal.require("buffer");
  const { fs } = internal.require("node_fs");
  const MiB = 2 ** 20;
  const data = Buffer.from(native.readFile(file));
  const size = data.length;
  const target = Buffer.allocUnsafeSlow(size + 5);
  target.fill(0x9d);
  const cursor = Buffer.alloc(3 * MiB);
  const view = new DataView(target.buffer, target.byteOffset + 7, MiB + 3);
  const borrowed = internal.toUint8(view);
  if (borrowed.buffer !== target.buffer || borrowed.byteOffset !== view.byteOffset) throw Error("destination must alias");
  const fd = fs.openSync(file, "r");
  const checks = [];
  let called = false;
  function onRead(error, count, returned) {
    if (error) throw error;
    called = true;
    checks.push(count === size - MiB && returned === target && target.subarray(0, count).equals(data.subarray(MiB)));
  }
  function operation() {
    if (wholeCopy) new Uint8Array(target);
    const positional = fs.readSync(fd, target, 0, size + 5, 0);
    checks.push(positional === size && target.subarray(0, size).equals(data));
    checks.push(target.subarray(size).every(byte => byte === 0x9d));
    checks.push(fs.readSync(fd, cursor, 0, cursor.length, null) === cursor.length && cursor.equals(data.subarray(0, cursor.length)));
    checks.push(fs.readSync(fd, cursor, 0, cursor.length, null) === cursor.length && cursor.equals(data.subarray(cursor.length, 2 * cursor.length)));
    fs.read(fd, target, 0, size, MiB, onRead);
    checks.push(!called);
    while (pending.length) pending.shift()();
    checks.push(called);
    checks.push(fs.readSync(fd, view, 0, view.byteLength, 2 * MiB) === view.byteLength && Buffer.from(borrowed).equals(data.subarray(2 * MiB, 3 * MiB + 3)));
    return checks;
  }
  return { operation, close() { fs.closeSync(fd); } };
})"#;

fn heap_bytes(engine: &QuickJs) -> usize {
    let Val::Object(fields) = engine.memory_usage() else {
        panic!("memory snapshot")
    };
    let (_, Val::Num(bytes)) = fields
        .into_iter()
        .find(|(key, _)| key == "heapTotal")
        .unwrap()
    else {
        panic!("heapTotal must be numeric")
    };
    bytes as usize
}

fn embedding_sample(whole_copy: bool) {
    let data: Vec<u8> = (0..SIZE).map(|i| (i % 251) as u8).collect();
    let fixture = Fixture::new(&data);
    let engine = QuickJs::new(Rc::new(Host));
    let reads = Rc::new(Reads::default());
    let native = natives(&engine, &reads);
    let setup = engine.eval_script(SETUP, "io-copy-embedding", 1).unwrap();
    let state = engine
        .call(
            &setup,
            &engine.undefined(),
            &[
                native,
                engine.value_from(fixture.0.to_str().unwrap().into()),
                engine.value_from(whole_copy.into()),
            ],
        )
        .unwrap();
    let operation = engine.get(&state, "operation").unwrap();
    let close = engine.get(&state, "close").unwrap();
    let baseline = heap_bytes(&engine);
    let undefined = engine.undefined();
    // SAFETY: this value roots the live embedding context for the measured call.
    let runtime = unsafe { qjs::JS_GetRuntime(undefined.ctx().as_raw().as_ptr()) };
    // This limit is test-only. No collection or production policy is changed.
    unsafe { qjs::JS_SetMemoryLimit(runtime, (baseline + LIMIT) as _) };
    reads.armed.set(true);
    let (result, largest, peak) = measure(|| engine.call(&operation, &undefined, &[]));
    reads.armed.set(false);
    // SAFETY: cached failure fields are allocation-free, including after refusal.
    let failure = unsafe { *quickjs_memory_telemetry() };
    unsafe { qjs::JS_SetMemoryLimit(runtime, 0) };
    engine.call(&close, &undefined, &[]).unwrap();
    println!(
        "embedding whole_copy={whole_copy}, baseline={baseline}, allowance={LIMIT}, largest_rust={largest}, peak_rust={peak}, reads={}, max_read={}, failure_category={}, failed_bytes={}",
        reads.count.get(),
        reads.largest.get(),
        failure.failed_category,
        failure.failed_size
    );
    assert!(
        largest < LIMIT && peak < LIMIT,
        "Rust allocation budget: {largest}, {peak}"
    );
    if whole_copy {
        assert!(
            result.is_err(),
            "whole-target JS copy must exceed the same allowance"
        );
        assert_eq!(
            reads.count.get(),
            0,
            "copy must fail before the first bounded request"
        );
        assert_eq!(failure.failed_category, 4, "ArrayBuffer backing refusal");
        assert_eq!(failure.failed_size, (SIZE + 5) as u64);
        return;
    }
    assert_eq!(
        engine.to_val(&result.unwrap()),
        Val::Array(vec![Val::Bool(true); 8])
    );
    assert_eq!(reads.count.get(), 89);
    assert_eq!(reads.largest.get(), MIB);
    assert_eq!(failure.failed_category, 0);
}

#[test]
fn shared_js_value_native_read_passes_both_allocation_limits() {
    embedding_sample(false);
}

#[test]
fn whole_target_js_copy_is_refused_before_the_same_bounded_reads() {
    embedding_sample(true);
}
