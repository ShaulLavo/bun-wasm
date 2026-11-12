//! Engine-side roots and pending thrown values. The core never owns JS values.
use crate::engine::{Engine, NativeError, Val};
use crate::vm::NestedEngine;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
#[path = "../../bunwasm-runtime/src/wasm/nested_frame.rs"]
mod frame;
#[path = "nested_token.rs"]
mod nested_token;
use nested_token::next_token;

type Value = <NestedEngine as Engine>::Value;

struct Invocation {
    token: u32,
    engine: NestedEngine,
    callback: Value,
    thrown: RefCell<Option<Value>>,
}
thread_local! {
    static NEXT: Cell<u32> = const { Cell::new(0) };
    static ACTIVE: RefCell<Vec<Rc<Invocation>>> = const { RefCell::new(Vec::new()) };
}
struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.with(|stack| {
            stack.borrow_mut().pop();
        });
    }
}

pub(crate) fn execute(
    engine: &NestedEngine,
    operation: &Value,
    callback: &Value,
) -> Result<Value, Value> {
    if ACTIVE.with(|stack| stack.borrow().len()) >= frame::MAX_DEPTH {
        return Err(engine.error_value(&NativeError::range_error(
            "Nested WebAssembly call depth exceeded",
        )));
    }
    let token = NEXT.with(|next| {
        let token = next_token(next.get(), token_in_use);
        next.set(token);
        token
    });
    let invocation = Rc::new(Invocation {
        token,
        engine: engine.clone(),
        callback: callback.clone(),
        thrown: RefCell::new(None),
    });
    ACTIVE.with(|stack| stack.borrow_mut().push(invocation.clone()));
    let _guard = Guard;
    let result = engine.call(
        operation,
        &engine.undefined(),
        &[engine.value_from(token.into())],
    );
    let thrown = invocation.thrown.borrow_mut().take();
    match thrown {
        Some(value) => Err(value),
        None => result,
    }
}

fn token_in_use(token: u32) -> bool {
    ACTIVE.with(|stack| stack.borrow().iter().any(|entry| entry.token == token))
}

pub(crate) extern "C" fn dispatch(token: u32, callback: u32, pointer: u32) -> u32 {
    let invocation = ACTIVE.with(|stack| stack.borrow().last().cloned());
    let Some(invocation) = invocation.filter(|invocation| invocation.token == token) else {
        return frame::BAD_FRAME;
    };
    // SAFETY: the core checked this exact live transport allocation and invocation.
    // The host is blocked until dispatch returns. No Rust view covers shared regions.
    let mut frame = unsafe { (pointer as *const frame::CallbackFrame).read_unaligned() };
    if frame.arguments as usize > frame::MAX_VALUES || frame.results as usize > frame::MAX_VALUES {
        return frame::BAD_FRAME;
    }
    let result = run_callback(&invocation, callback, &mut frame);
    match result {
        Ok(()) => {
            write_frame(pointer, frame);
            frame::OK
        }
        Err(thrown) => {
            *invocation.thrown.borrow_mut() = Some(thrown);
            frame::PENDING_EXCEPTION
        }
    }
}
fn invalid(engine: &NestedEngine) -> Value {
    engine.error_value(&NativeError::type_error("Invalid nested callback frame"))
}
fn run_callback(
    invocation: &Invocation,
    callback: u32,
    frame: &mut frame::CallbackFrame,
) -> Result<(), Value> {
    let engine = &invocation.engine;
    let arguments = frame.slots[..frame.arguments as usize]
        .iter()
        .map(|value| decode(*value))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid(engine))?;
    let result = engine.call(
        &invocation.callback,
        &engine.undefined(),
        &[
            engine.value_from(callback.into()),
            engine.value_from(Val::Array(arguments)),
        ],
    )?;
    let Val::Array(values) = engine.to_val(&result) else {
        return Err(invalid(engine));
    };
    if values.len() != frame.results as usize {
        return Err(invalid(engine));
    }
    for (target, value) in frame.slots.iter_mut().zip(values) {
        *target = encode(value).ok_or_else(|| invalid(engine))?;
    }
    Ok(())
}
fn decode(slot: frame::Slot) -> Option<Val> {
    if slot.reserved != 0 {
        return None;
    }
    Some(match slot.kind {
        0 => Val::Num(f64::from(slot.bits as i32)),
        1 => Val::BigInt(slot.bits as i64),
        2 => Val::Num(f64::from(f32::from_bits(slot.bits as u32))),
        3 => Val::Num(f64::from_bits(slot.bits)),
        _ => return None,
    })
}
fn encode(value: Val) -> Option<frame::Slot> {
    let Val::Object(fields) = value else {
        return None;
    };
    let kind = fields
        .iter()
        .find(|(key, _)| key == "type")
        .map(|(_, value)| value);
    let value = fields
        .iter()
        .find(|(key, _)| key == "value")
        .map(|(_, value)| value)?;
    let (kind, bits) = match (kind, value) {
        (Some(Val::Str(ty)), Val::Num(value)) if ty == "i32" => (0, *value as i32 as u32 as u64),
        (Some(Val::Str(ty)), Val::Num(value)) if ty == "f32" => {
            (2, u64::from((*value as f32).to_bits()))
        }
        (Some(Val::Str(ty)), Val::Num(value)) if ty == "f64" => (3, value.to_bits()),
        (Some(Val::Str(ty)), Val::BigInt(value)) if ty == "i64" => (1, *value as u64),
        (Some(Val::Str(ty)), Val::BigUint(value)) if ty == "i64" => (1, *value),
        _ => return None,
    };
    Some(frame::Slot {
        kind,
        reserved: 0,
        bits,
    })
}

fn write_frame(pointer: u32, frame: frame::CallbackFrame) {
    // SAFETY: dispatch validated this exact frame allocation through the core.
    unsafe { (pointer as *mut frame::CallbackFrame).write_unaligned(frame) };
}
