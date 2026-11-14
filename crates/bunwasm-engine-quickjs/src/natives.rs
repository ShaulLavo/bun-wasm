use std::rc::Rc;

use crate::driver::Core;
use crate::engine::{Engine, data_fn};

pub(crate) fn bootstrap<E: Engine>(e: &E, core: &Rc<Core<E>>) -> Result<E::Value, E::Value> {
    let table = core.client.natives().map_err(|err| e.error_value(&err))?;
    let functions = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(id, name)| {
            let client = core.client;
            let native_id = u32::try_from(id).expect("native ID");
            let function = data_fn::<E>(move |values| client.native(native_id, values));
            (name, function)
        })
        .collect();
    crate::value_natives::bootstrap(e, core, functions, table.constants)
}
