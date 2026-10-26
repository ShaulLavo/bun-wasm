use std::rc::Rc;

use crate::client::CoreClient;
use crate::driver::Core;
use crate::engine::{Engine, ValueFn};

/// Adapt a data native: convert the arguments to [`Val`] and back.
fn data_fn<E: Engine>(client: CoreClient, native_id: u32) -> ValueFn<E> {
    Rc::new(move |e: &E, args: &[E::Value]| {
        let values = args.iter().map(|value| e.to_val(value)).collect();
        client
            .native(native_id, values)
            .map(|value| e.value_from(value))
            .map_err(|error| e.error_value(&error))
    })
}

pub(crate) fn bootstrap<E: Engine>(e: &E, core: &Rc<Core<E>>) -> Result<E::Value, E::Value> {
    let table = core.client.natives().map_err(|err| e.error_value(&err))?;
    let functions = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(id, name)| {
            let function = data_fn::<E>(core.client, u32::try_from(id).expect("native ID"));
            (name, function)
        })
        .collect();
    crate::value_natives::bootstrap(e, core, functions, table.constants)
}
