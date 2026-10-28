use bunwasm_semver::{CallFrame, JSGlobalObject, JSValue, JsError};

use crate::data::{NativeError, Val};
use crate::natives::Table;

pub fn install(table: &mut Table) {
    for (name, function, _) in bunwasm_semver::functions() {
        let native_name = match name {
            "satisfies" => "semverSatisfies",
            "order" => "semverOrder",
            "intersects" => "semverIntersects",
            _ => unreachable!("unexpected Bun.semver export"),
        };
        table.add(native_name, move |arguments| {
            let global = JSGlobalObject::default();
            let values = (0..arguments.0.len())
                .map(|index| arguments.str(index).map(|value| global.string(value)))
                .collect::<Result<Vec<_>, _>>()?;
            let result = function(&global, &CallFrame::new(values)).map_err(native_error)?;
            Ok(result_value(result))
        });
    }
}

fn native_error(error: JsError) -> NativeError {
    match error {
        JsError::Error(message) => NativeError::error(message),
        JsError::TypeError(message) => NativeError::type_error(message),
        JsError::OutOfMemory => NativeError::error("Out of memory"),
    }
}

fn result_value(value: JSValue) -> Val {
    if let Some(value) = value.as_bool() {
        return Val::Bool(value);
    }
    if let Some(value) = value.as_int32() {
        return Val::Num(f64::from(value));
    }
    unreachable!("Bun.semver returns a boolean or an int32")
}
