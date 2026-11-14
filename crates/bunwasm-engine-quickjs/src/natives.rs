use std::rc::Rc;

use crate::client::CoreClient;
use crate::data::{Val, WORD_ARGS, drop_tree};
use crate::driver::Core;
use crate::engine::{Engine, ValueFn, data_fn};

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

/// Adapt a word native: numbers in, one number out, with no checked allocation and no thrown
/// error. Reading a number and making one do not run program code on any engine. What the
/// engine's own callback wrapper allocates around this closure is outside the transport.
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
    let lane = crate::value_natives::LaneCommit::find(&table.words);
    let data = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            let client = core.client;
            let native_id = id(index);
            let function = data_fn::<E>(move |values| client.native(native_id, values));
            (name, function)
        });
    let words = table
        .words
        .into_iter()
        .enumerate()
        .map(|(index, name)| (name, word_fn::<E>(core.client, id(index))));
    let functions = data.chain(words).collect();
    crate::value_natives::bootstrap(e, core, functions, table.constants, lane)
}
