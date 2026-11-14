// Validation sides only (SPIDERMONKEY_TRANSFER_FAULT=1 to the side's producer). The build
// script compiles this file for such a side and for no other. See
// crates/bunwasm-engine-quickjs/src/transfer_fault.rs for what the two functions are for.
//
// They are natives of their own, not the adapter's `native_dispatch`, which holds `this` and
// every argument in a handle before it calls Rust: entering these asks for no memory.
#include <stdint.h>

#include <js/CallArgs.h>
#include <js/PropertyAndElement.h>
#include <js/Realm.h>
#include <js/RootingAPI.h>
#include <js/TypeDecls.h>
#include <jsapi.h>

extern "C" {
// transfer_fault.rs
int32_t bunwasm_transfer_fault_leave(void);
void bunwasm_transfer_fault_watch(void);
// engine.cpp
JSContext* bsm_context(void);
JSObject* bsm_global_object(void);
}

namespace {

bool report(JSContext*, unsigned argc, JS::Value* vp) {
  JS::CallArgsFromVp(argc, vp).rval().setInt32(bunwasm_transfer_fault_leave());
  return true;
}

bool watch(JSContext*, unsigned argc, JS::Value* vp) {
  bunwasm_transfer_fault_watch();
  JS::CallArgsFromVp(argc, vp).rval().setUndefined();
  return true;
}

}  // namespace

extern "C" void bsm_install_transfer_fault(void) {
  JSContext* cx = bsm_context();
  JS::RootedObject global(cx, bsm_global_object());
  JSAutoRealm realm(cx, global);
  if (!JS_DefineFunction(cx, global, "__transferFault", report, 0, 0) ||
      !JS_DefineFunction(cx, global, "__transferFaultWatch", watch, 0, 0)) {
    __builtin_trap();
  }
}
