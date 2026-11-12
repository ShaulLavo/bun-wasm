use std::rc::Rc;

use crate::client::CoreClient;
use crate::data::{Val, WORD_ARGS, drop_tree};
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

/// A number or boolean as a word. Word natives take nothing else, so any other value is zero.
fn word(value: Val) -> u32 {
    match value {
        Val::Num(number) => number as u32,
        Val::Bool(flag) => u32::from(flag),
        other => {
            drop_tree(other);
            0
        }
    }
}

/// Adapt a word native: numbers in, one number out, with no allocation and no thrown error.
fn word_fn<E: Engine>(client: CoreClient, op: u32) -> ValueFn<E> {
    Rc::new(move |e: &E, args: &[E::Value]| {
        let mut words = [0; WORD_ARGS];
        for (slot, value) in words.iter_mut().zip(args) {
            *slot = word(e.to_val(value));
        }
        Ok(e.value_from(Val::Num(client.word(op, words) as f64)))
    })
}

pub(crate) fn bootstrap<E: Engine>(e: &E, core: &Rc<Core<E>>) -> Result<E::Value, E::Value> {
    let table = core.client.natives().map_err(|err| e.error_value(&err))?;
    let id = |index: usize| u32::try_from(index).expect("native ID");
    let data = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(index, name)| (name, data_fn::<E>(core.client, id(index))));
    let words = table
        .words
        .into_iter()
        .enumerate()
        .map(|(index, name)| (name, word_fn::<E>(core.client, id(index))));
    crate::value_natives::bootstrap(e, core, data.chain(words).collect(), table.constants)
}
