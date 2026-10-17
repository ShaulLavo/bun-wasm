//! Building the `native` object for an engine, and the natives that work on
//! engine values (module loading, promise/proxy introspection, the async
//! context, GC). Written once against [`Engine`].

use std::rc::Rc;

use crate::engine::{Args, DataFn, Engine, NativeError, PromiseState, Val, ValueFn};
use crate::{modules, natives, Core};

/// Adapt a data native: convert the arguments to [`Val`] and back.
fn data_fn<E: Engine>(f: DataFn) -> ValueFn<E> {
    Rc::new(move |e: &E, args: &[E::Value]| {
        let vals: Vec<Val> = args.iter().map(|a| e.to_val(a)).collect();
        match f(Args(&vals)) {
            Ok(v) => Ok(e.from_val(v)),
            Err(err) => Err(e.error_value(&err)),
        }
    })
}

fn arg<E: Engine>(e: &E, args: &[E::Value], i: usize) -> E::Value {
    args.get(i).cloned().unwrap_or_else(|| e.undefined())
}

fn arg_str<E: Engine>(e: &E, args: &[E::Value], i: usize) -> Result<String, E::Value> {
    match args.get(i).map(|v| e.to_val(v)) {
        Some(Val::Str(s)) => Ok(s),
        _ => Err(e.error_value(&NativeError::type_error("expected a string argument"))),
    }
}

/// Install every native, evaluate src/js/bootstrap.js with them, and return
/// the `internal` object it builds.
pub fn bootstrap<E: Engine>(e: &E, core: &Rc<Core<E>>) -> Result<E::Value, E::Value> {
    let native = e.new_object();
    let table = natives::table(&core.state);
    // `group.name` entries go on a nested object (`native.sqlite.open`).
    let mut groups: Vec<(&str, E::Value)> = Vec::new();
    for (name, f) in table.functions {
        let Some((group, short)) = name.split_once('.') else {
            e.set(&native, name, e.new_function(name, data_fn::<E>(f)))?;
            continue;
        };
        if !groups.iter().any(|(g, _)| *g == group) {
            groups.push((group, e.new_object()));
        }
        let target = &groups.iter().find(|(g, _)| *g == group).expect("group added above").1;
        e.set(target, short, e.new_function(short, data_fn::<E>(f)))?;
    }
    for (group, obj) in groups {
        e.set(&native, group, obj)?;
    }
    for (name, value) in table.constants {
        e.set(&native, name, e.from_val(value))?;
    }
    for (name, f) in value_natives(core) {
        e.set(&native, name, e.new_function(name, f))?;
    }
    e.set(&native, "engine", e.from_val(e.name().into()))?;
    let factory = load_polyfill(e, "bootstrap")?;
    e.call(&factory, &e.undefined(), &[native])
}

fn load_polyfill<E: Engine>(e: &E, name: &str) -> Result<E::Value, E::Value> {
    let Some(source) = modules::polyfill_source(name) else {
        return Err(e.error_value(&NativeError::error(format!("bun-wasm: missing internal module {name}"))));
    };
    e.eval_script(source, &format!("bun-wasm:{name}"), 1)
}

fn value_natives<E: Engine>(core: &Rc<Core<E>>) -> Vec<(&'static str, ValueFn<E>)> {
    let mut list: Vec<(&'static str, ValueFn<E>)> = Vec::new();
    let c = core.clone();
    list.push(("compileCjs", Rc::new(move |e: &E, args: &[E::Value]| {
        let path = arg_str(e, args, 0)?;
        let (code, _) = c.state.load_source(&path).map_err(|err| e.error_value(&err))?;
        let (wrapped, first_line) = modules::cjs_wrapper(&code);
        e.eval_script(&wrapped, &path, first_line)
    })));
    let c = core.clone();
    list.push(("requireEsm", Rc::new(move |e: &E, args: &[E::Value]| require_esm(e, &c, &arg_str(e, args, 0)?))));
    list.push(("importModule", Rc::new(|e: &E, args: &[E::Value]| e.import_module(&arg_str(e, args, 0)?))));
    list.push(("evalScript", Rc::new(|e: &E, args: &[E::Value]| {
        let code = arg_str(e, args, 0)?;
        let filename = arg_str(e, args, 1).unwrap_or_else(|_| "evalmachine.<anonymous>".to_owned());
        e.eval_script(&code, &filename, 1)
    })));
    list.push(("loadPolyfill", Rc::new(|e: &E, args: &[E::Value]| load_polyfill(e, &arg_str(e, args, 0)?))));
    list.push(("promiseState", Rc::new(|e: &E, args: &[E::Value]| {
        let state = match e.promise_state(&arg(e, args, 0)) {
            Some(PromiseState::Pending) => "pending",
            Some(PromiseState::Rejected) => "rejected",
            _ => "fulfilled",
        };
        Ok(e.from_val(state.into()))
    })));
    list.push(("promiseResult", Rc::new(|e: &E, args: &[E::Value]| Ok(e.promise_result(&arg(e, args, 0))))));
    list.push(("isProxy", Rc::new(|e: &E, args: &[E::Value]| Ok(e.from_val(e.is_proxy(&arg(e, args, 0)).into())))));
    list.push(("transferArrayBuffers", Rc::new(|e: &E, args: &[E::Value]| {
        let array = arg(e, args, 0);
        let Val::Num(length) = e.to_val(&e.get(&array, "length")?) else {
            return Err(e.error_value(&NativeError::type_error("Expected a buffer list")));
        };
        let buffers = (0..length as usize).map(|i| e.get(&array, &i.to_string())).collect::<Result<Vec<_>, _>>()?;
        if buffers.iter().any(|buffer| !e.is_detachable_buffer(buffer)) {
            return Err(e.error_value(&NativeError::type_error("ArrayBuffer is not detachable").named("DataCloneError")));
        }
        for buffer in &buffers {
            e.detach_buffer(buffer);
        }
        Ok(e.undefined())
    })));
    list.push(("isPromise", Rc::new(|e: &E, args: &[E::Value]| Ok(e.from_val(e.is_promise(&arg(e, args, 0)).into())))));
    list.push(("isError", Rc::new(|e: &E, args: &[E::Value]| Ok(e.from_val(e.is_error(&arg(e, args, 0)).into())))));
    list.push(("getProxyTarget", Rc::new(|e: &E, args: &[E::Value]| Ok(e.proxy_target(&arg(e, args, 0))))));
    list.push(("iteratorEntries", Rc::new(|e: &E, args: &[E::Value]| {
        Ok(e.iterator_entries(&arg(e, args, 0)).unwrap_or_else(|| e.undefined()))
    })));
    list.push(("ownKeysInOrder", Rc::new(|e: &E, args: &[E::Value]| {
        Ok(e.own_keys_in_order(&arg(e, args, 0)).unwrap_or_else(|| e.undefined()))
    })));
    list.push(("getAsyncContext", Rc::new(|e: &E, _: &[E::Value]| Ok(e.async_context()))));
    list.push(("setAsyncContext", Rc::new(|e: &E, args: &[E::Value]| {
        e.set_async_context(&arg(e, args, 0));
        Ok(e.undefined())
    })));
    let c = core.clone();
    list.push(("runMicrotasks", Rc::new(move |e: &E, _: &[E::Value]| {
        c.drain_jobs(e);
        Ok(e.undefined())
    })));
    list.push(("gc", Rc::new(|e: &E, _: &[E::Value]| {
        e.gc();
        Ok(e.undefined())
    })));
    list.push(("memoryUsage", Rc::new(|e: &E, _: &[E::Value]| Ok(e.from_val(e.memory_usage())))));
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
