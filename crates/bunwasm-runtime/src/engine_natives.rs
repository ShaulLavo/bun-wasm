//! Building the `native` object for an engine, and the natives that work on
//! engine values (module loading, promise/proxy introspection, the async
//! context, GC). Written once against [`Engine`].

use std::rc::Rc;

use crate::engine::{Args, DataFn, Engine, Val, ValueFn};
use crate::{Core, natives};

#[path = "../../bunwasm-engine-quickjs/src/value_natives.rs"]
mod value_natives;

/// Adapt a data native: convert the arguments to [`Val`] and back.
pub(crate) fn data_fn<E: Engine>(name: &str, native_id: u32, f: DataFn) -> ValueFn<E> {
    if name == "writeStdout" {
        return stdout_fn::<E>(native_id, f);
    }
    Rc::new(move |e: &E, args: &[E::Value]| {
        let vals: Vec<Val> = args.iter().map(|a| e.to_val(a)).collect();
        match f(Args(&vals)) {
            Ok(v) => Ok(e.value_from(v)),
            Err(err) => Err(e.error_value(&err)),
        }
    })
}

pub(crate) fn stdout_fn<E: Engine>(native_id: u32, f: DataFn) -> ValueFn<E> {
    let dispatcher = crate::ops::Dispatcher::new(std::num::NonZeroU32::MIN, native_id, f)
        .expect("data native ID fits operation range");
    Rc::new(move |e: &E, args: &[E::Value]| {
        let values = args.iter().map(|value| e.to_val(value)).collect();
        match dispatcher.call(values) {
            Ok(value) => Ok(e.value_from(value)),
            Err(error) => Err(e.error_value(&error)),
        }
    })
}

pub(crate) fn bootstrap<E: Engine>(e: &E, core: &Rc<Core<E>>) -> Result<E::Value, E::Value> {
    let table = natives::table(&core.state);
    let functions = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(id, (name, f))| {
            (
                name.to_owned(),
                data_fn::<E>(name, u32::try_from(id).expect("native ID"), f),
            )
        })
        .collect();
    let constants = table
        .constants
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect();
    value_natives::bootstrap(e, core, functions, constants)
}
