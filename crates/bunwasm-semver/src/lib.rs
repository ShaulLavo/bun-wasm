#[path = "../../../vendor/bun/src/semver_jsc/SemverObject.rs"]
pub mod semver_object;

use bun_jsc::bindgen::JsHeap;
pub use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsError, JsResult};

// Bun generates the callers of `satisfies` and `order` from `SemverObject.bind.ts`:
// two UTF-8 string arguments, a boolean or an int32 back. These are that glue.
fn satisfies(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let version = frame.argument(0).to_utf8(global)?;
    let range = frame.argument(1).to_utf8(global)?;
    let satisfied = semver_object::satisfies(&version, &range)?;
    Ok(JSValue::js_boolean(satisfied))
}

fn order(global: &JSGlobalObject, frame: &CallFrame) -> JsResult<JSValue> {
    let left = frame.argument(0).to_utf8(global)?;
    let right = frame.argument(1).to_utf8(global)?;
    let heap = JsHeap::default();
    let ordering = semver_object::order(&heap, &left, &right)?;
    Ok(JSValue::js_number_from_int32(ordering))
}

pub fn functions() -> [bun_jsc::HostFunction; 3] {
    [
        ("satisfies", satisfies, 2),
        ("order", order, 2),
        (
            "intersects",
            semver_object::__jsc_host_intersects_for_testing,
            2,
        ),
    ]
}
