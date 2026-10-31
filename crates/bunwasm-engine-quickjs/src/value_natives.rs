use std::rc::Rc;

use crate::Core;
use crate::engine::{Engine, NativeError, PromiseState, Val, ValueFn};

#[path = "runtime_js_measurement.rs"]
mod measurement;

fn arg<E: Engine>(e: &E, args: &[E::Value], i: usize) -> E::Value {
    args.get(i).cloned().unwrap_or_else(|| e.undefined())
}

fn arg_str<E: Engine>(e: &E, args: &[E::Value], i: usize) -> Result<String, E::Value> {
    match args.get(i).map(|v| e.to_val(v)) {
        Some(Val::Str(s)) => Ok(s),
        _ => Err(e.error_value(&NativeError::type_error("expected a string argument"))),
    }
}

pub(crate) fn load_polyfill<E: Engine>(
    e: &E,
    core: &Core<E>,
    name: &str,
) -> Result<E::Value, E::Value> {
    let source = measurement::measure(e.name(), "source-load", name, 0, || core.polyfill(name))
        .map_err(|err| e.error_value(&err))?;
    measurement::measure(e.name(), "factory-eval", name, source.len(), || {
        e.eval_script(&source, &format!("bun-wasm:{name}"), 1)
    })
}

fn eval_runtime_builtin<E: Engine>(
    e: &E,
    code: &str,
    filename: &str,
    first_line: i32,
) -> Result<E::Value, E::Value> {
    let name = filename.strip_prefix("bun-builtin:").unwrap_or("generated");
    measurement::measure(e.name(), "builtin-eval", name, code.len(), || {
        e.eval_script(code, filename, first_line)
    })
}

fn eval_arguments<E: Engine>(e: &E, args: &[E::Value]) -> Result<(String, String, i32), E::Value> {
    let code = arg_str(e, args, 0)?;
    let filename = arg_str(e, args, 1).unwrap_or_else(|_| "evalmachine.<anonymous>".to_owned());
    let first_line = match args.get(2).map(|value| e.to_val(value)) {
        Some(Val::Num(line)) => line as i32,
        _ => 1,
    };
    Ok((code, filename, first_line))
}

pub(crate) fn value_natives<E: Engine>(core: &Rc<Core<E>>) -> Vec<(&'static str, ValueFn<E>)> {
    let mut list: Vec<(&'static str, ValueFn<E>)> = Vec::new();
    let c = core.clone();
    list.push((
        "compileCjs",
        Rc::new(move |e: &E, args: &[E::Value]| {
            let path = arg_str(e, args, 0)?;
            let (wrapped, first_line) = c.compile_cjs(&path).map_err(|err| e.error_value(&err))?;
            e.eval_script(&wrapped, &path, first_line)
        }),
    ));
    let c = core.clone();
    list.push((
        "requireEsm",
        Rc::new(move |e: &E, args: &[E::Value]| require_esm(e, &c, &arg_str(e, args, 0)?)),
    ));
    list.push((
        "importModule",
        Rc::new(|e: &E, args: &[E::Value]| e.import_module(&arg_str(e, args, 0)?)),
    ));
    list.push((
        "evalScript",
        Rc::new(|e: &E, args: &[E::Value]| {
            let (code, filename, first_line) = eval_arguments(e, args)?;
            e.eval_script(&code, &filename, first_line)
        }),
    ));
    list.push((
        "evalBuiltin",
        Rc::new(|e: &E, args: &[E::Value]| {
            let (code, filename, first_line) = eval_arguments(e, args)?;
            eval_runtime_builtin(e, &code, &filename, first_line)
        }),
    ));
    let c = core.clone();
    list.push((
        "loadPolyfill",
        Rc::new(move |e: &E, args: &[E::Value]| load_polyfill(e, &c, &arg_str(e, args, 0)?)),
    ));
    list.push((
        "promiseState",
        Rc::new(|e: &E, args: &[E::Value]| {
            let state = match e.promise_state(&arg(e, args, 0)) {
                Some(PromiseState::Pending) => "pending",
                Some(PromiseState::Rejected) => "rejected",
                _ => "fulfilled",
            };
            Ok(e.value_from(state.into()))
        }),
    ));
    list.push((
        "promiseResult",
        Rc::new(|e: &E, args: &[E::Value]| Ok(e.promise_result(&arg(e, args, 0)))),
    ));
    list.push((
        "promiseThen",
        Rc::new(|e: &E, args: &[E::Value]| {
            e.promise_then(&arg(e, args, 0), &arg(e, args, 1), &arg(e, args, 2))
        }),
    ));
    list.push((
        "isProxy",
        Rc::new(|e: &E, args: &[E::Value]| Ok(e.value_from(e.is_proxy(&arg(e, args, 0)).into()))),
    ));
    list.push((
        "transferArrayBuffers",
        Rc::new(|e: &E, args: &[E::Value]| {
            let array = arg(e, args, 0);
            let Val::Num(length) = e.to_val(&e.get(&array, "length")?) else {
                return Err(e.error_value(&NativeError::type_error("Expected a buffer list")));
            };
            let buffers = (0..length as usize)
                .map(|i| e.get(&array, &i.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            if buffers.iter().any(|buffer| !e.is_detachable_buffer(buffer)) {
                return Err(e.error_value(
                    &NativeError::type_error("ArrayBuffer is not detachable")
                        .named("DataCloneError"),
                ));
            }
            for buffer in &buffers {
                e.detach_buffer(buffer);
            }
            Ok(e.undefined())
        }),
    ));
    list.push((
        "isPromise",
        Rc::new(|e: &E, args: &[E::Value]| Ok(e.value_from(e.is_promise(&arg(e, args, 0)).into()))),
    ));
    list.push((
        "isError",
        Rc::new(|e: &E, args: &[E::Value]| Ok(e.value_from(e.is_error(&arg(e, args, 0)).into()))),
    ));
    list.push((
        "getProxyTarget",
        Rc::new(|e: &E, args: &[E::Value]| Ok(e.proxy_target(&arg(e, args, 0)))),
    ));
    list.push((
        "iteratorEntries",
        Rc::new(|e: &E, args: &[E::Value]| {
            Ok(e.iterator_entries(&arg(e, args, 0))
                .unwrap_or_else(|| e.undefined()))
        }),
    ));
    list.push((
        "ownKeysInOrder",
        Rc::new(|e: &E, args: &[E::Value]| {
            Ok(e.own_keys_in_order(&arg(e, args, 0))
                .unwrap_or_else(|| e.undefined()))
        }),
    ));
    list.push((
        "getAsyncContext",
        Rc::new(|e: &E, _: &[E::Value]| Ok(e.async_context())),
    ));
    list.push((
        "setAsyncContext",
        Rc::new(|e: &E, args: &[E::Value]| {
            e.set_async_context(&arg(e, args, 0));
            Ok(e.undefined())
        }),
    ));
    let c = core.clone();
    list.push((
        "runMicrotasks",
        Rc::new(move |e: &E, _: &[E::Value]| {
            c.drain_jobs(e);
            Ok(e.undefined())
        }),
    ));
    list.push((
        "gc",
        Rc::new(|e: &E, _: &[E::Value]| {
            e.gc();
            Ok(e.undefined())
        }),
    ));
    list.push((
        "memoryUsage",
        Rc::new(|e: &E, _: &[E::Value]| Ok(e.value_from(e.memory_usage()))),
    ));
    list
}

/// `require()` of an ES module: import it and run the job queue until it
/// settles. Modules waiting on timers (top-level await) can't be required.
fn require_esm<E: Engine>(e: &E, core: &Core<E>, path: &str) -> Result<E::Value, E::Value> {
    let promise = e.import_module(path)?;
    while e.promise_state(&promise) == Some(PromiseState::Pending) {
        if !core.drain_jobs(e) {
            break;
        }
    }
    match e.promise_state(&promise) {
        Some(PromiseState::Rejected) => Err(e.promise_result(&promise)),
        Some(PromiseState::Pending) => Err(e.error_value(&NativeError::error(format!(
            "require() async module \"{path}\" is unsupported. use \"await import()\" instead."
        )))),
        _ => Ok(e.promise_result(&promise)),
    }
}

pub(crate) fn bootstrap<E: Engine>(
    e: &E,
    core: &Rc<Core<E>>,
    functions: Vec<(String, ValueFn<E>)>,
    constants: Vec<(String, Val)>,
) -> Result<E::Value, E::Value> {
    let native = e.new_object();
    let memory_span = functions
        .iter()
        .find(|(name, _)| name == "wasm.memorySpan")
        .map(|(_, function)| function.clone())
        .ok_or_else(|| e.error_value(&NativeError::error("missing wasm.memorySpan")))?;
    e.set(
        &native,
        "wasmMemoryBuffer",
        e.new_function("wasmMemoryBuffer", wasm_memory_buffer(memory_span)),
    )?;
    let mut groups = std::collections::HashMap::new();
    for (name, function) in functions {
        install(e, &native, &mut groups, &name, function)?;
    }
    for (group, object) in groups {
        e.set(&native, &group, object)?;
    }
    for (name, value) in constants {
        e.set(&native, &name, e.value_from(value))?;
    }
    for (name, function) in value_natives(core) {
        e.set(&native, name, e.new_function(name, function))?;
    }
    e.set(&native, "engine", e.value_from(e.name().into()))?;
    let factory = load_polyfill(e, core, "bootstrap")?;
    measurement::measure(e.name(), "bootstrap-execute", "bootstrap", 0, || {
        e.call(&factory, &e.undefined(), &[native])
    })
}

/// `wasmMemoryBuffer(resource, previous)`: detach `previous`, the buffer of an older
/// generation, then view the memory's current bytes. The span comes from core for this
/// session's memory resource; JavaScript never supplies an address.
fn wasm_memory_buffer<E: Engine>(memory_span: ValueFn<E>) -> ValueFn<E> {
    Rc::new(move |e: &E, args: &[E::Value]| {
        let previous = arg(e, args, 1);
        if !e.is_undefined(&previous) && !e.detach_wasm_memory_buffer(&previous) {
            return Err(e.error_value(&NativeError::type_error(
                "Expected a WebAssembly.Memory buffer",
            )));
        }
        let span = memory_span(e, &[arg(e, args, 0)])?;
        let (data, length) = checked_span(&e.to_val(&span)).map_err(|err| e.error_value(&err))?;
        // SAFETY: the bytes lie inside this process's linear memory. Core's store keeps
        // them until the session ends and moves them only by growth, after which the
        // WebAssembly polyfill detaches this buffer before user code runs.
        Ok(unsafe { e.wasm_memory_buffer(data, length) })
    })
}

fn checked_span(span: &Val) -> Result<(*mut u8, usize), NativeError> {
    let invalid = || NativeError::error("invalid WebAssembly memory span");
    let Val::Object(fields) = span else {
        return Err(invalid());
    };
    let field = |key: &str| match fields.iter().find(|(name, _)| name == key) {
        Some((_, Val::Num(value))) if *value >= 0.0 && value.fract() == 0.0 => Ok(*value as u64),
        _ => Err(invalid()),
    };
    let (pointer, length) = (field("pointer")?, field("length")?);
    let end = pointer.checked_add(length).ok_or_else(invalid)?;
    if pointer == 0 || !length.is_multiple_of(65_536) || end > linear_memory_bytes() {
        return Err(invalid());
    }
    Ok((pointer as usize as *mut u8, length as usize))
}

#[cfg(target_arch = "wasm32")]
fn linear_memory_bytes() -> u64 {
    core::arch::wasm32::memory_size(0) as u64 * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
fn linear_memory_bytes() -> u64 {
    u64::MAX
}

fn install<E: Engine>(
    e: &E,
    native: &E::Value,
    groups: &mut std::collections::HashMap<String, E::Value>,
    name: &str,
    function: ValueFn<E>,
) -> Result<(), E::Value> {
    let Some((group, short)) = name.split_once('.') else {
        return e.set(native, name, e.new_function(name, function));
    };
    let target = groups
        .entry(group.to_owned())
        .or_insert_with(|| e.new_object());
    e.set(target, short, e.new_function(short, function))
}
