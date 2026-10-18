// Temporary native-input CI cache measurement. Removed before delivery.
#[path = "../../../vendor/bun/src/semver_jsc/SemverObject.rs"]
pub mod semver_object;

pub use bun_jsc::{CallFrame, JSGlobalObject, JSValue, JsError, JsResult};

pub fn functions() -> Vec<bun_jsc::HostFunction> {
    let global = JSGlobalObject::default();
    let mut functions = global.host_functions(semver_object::create(&global));
    functions.push((
        "intersects",
        semver_object::__jsc_host_intersects_for_testing,
        2,
    ));
    functions
}
