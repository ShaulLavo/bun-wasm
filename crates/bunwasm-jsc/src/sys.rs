//! Hand-written declarations for the part of the JavaScriptCore C API this crate uses
//! (JSBase.h, JSContextRef.h, JSStringRef.h, JSValueRef.h, JSObjectRef.h, JSTypedArray.h,
//! JSContextRefPrivate.h), plus cpp/helpers.cpp.
#![allow(non_camel_case_types, non_snake_case, dead_code)]
use core::ffi::{c_char, c_int, c_uint, c_void};

#[repr(C)]
pub struct OpaqueJSContext {
    _p: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSValue {
    _p: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSString {
    _p: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSClass {
    _p: [u8; 0],
}

pub type JSContextRef = *const OpaqueJSContext;
pub type JSGlobalContextRef = *mut OpaqueJSContext;
pub type JSValueRef = *const OpaqueJSValue;
pub type JSObjectRef = *mut OpaqueJSValue;
pub type JSStringRef = *mut OpaqueJSString;
pub type JSClassRef = *mut OpaqueJSClass;
pub type JSChar = u16;
pub type JSPropertyAttributes = c_uint;

pub const kJSPropertyAttributeNone: JSPropertyAttributes = 0;
pub const kJSPropertyAttributeReadOnly: JSPropertyAttributes = 1 << 1;
pub const kJSPropertyAttributeDontEnum: JSPropertyAttributes = 1 << 2;

pub type JSType = c_uint;
pub const kJSTypeUndefined: JSType = 0;
pub const kJSTypeNull: JSType = 1;
pub const kJSTypeBoolean: JSType = 2;
pub const kJSTypeNumber: JSType = 3;
pub const kJSTypeString: JSType = 4;
pub const kJSTypeObject: JSType = 5;
pub const kJSTypeSymbol: JSType = 6;

pub type JSTypedArrayType = c_uint;
pub const kJSTypedArrayTypeUint8Array: JSTypedArrayType = 3;
pub const kJSTypedArrayTypeArrayBuffer: JSTypedArrayType = 9;
pub const kJSTypedArrayTypeNone: JSTypedArrayType = 10;

pub type JSObjectCallAsFunctionCallback = unsafe extern "C" fn(
    ctx: JSContextRef,
    function: JSObjectRef,
    this: JSObjectRef,
    argc: usize,
    argv: *const JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef;
pub type JSTypedArrayBytesDeallocator = unsafe extern "C" fn(bytes: *mut c_void, context: *mut c_void);

unsafe extern "C" {
    pub fn JSGlobalContextCreate(globalObjectClass: JSClassRef) -> JSGlobalContextRef;
    pub fn JSGlobalContextRelease(ctx: JSGlobalContextRef);
    pub fn JSContextGetGlobalObject(ctx: JSContextRef) -> JSObjectRef;
    pub fn JSEvaluateScript(
        ctx: JSContextRef,
        script: JSStringRef,
        thisObject: JSObjectRef,
        sourceURL: JSStringRef,
        startingLineNumber: c_int,
        exception: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSGarbageCollect(ctx: JSContextRef);

    pub fn JSStringCreateWithCharacters(chars: *const JSChar, numChars: usize) -> JSStringRef;
    pub fn JSStringCreateWithUTF8CString(string: *const c_char) -> JSStringRef;
    pub fn JSStringRelease(string: JSStringRef);
    pub fn JSStringGetLength(string: JSStringRef) -> usize;
    pub fn JSStringGetCharactersPtr(string: JSStringRef) -> *const JSChar;

    pub fn JSValueGetType(ctx: JSContextRef, value: JSValueRef) -> JSType;
    pub fn JSValueIsUndefined(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsNull(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsString(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsObject(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueGetTypedArrayType(ctx: JSContextRef, value: JSValueRef, exception: *mut JSValueRef) -> JSTypedArrayType;
    pub fn JSValueMakeUndefined(ctx: JSContextRef) -> JSValueRef;
    pub fn JSValueMakeNull(ctx: JSContextRef) -> JSValueRef;
    pub fn JSValueMakeBoolean(ctx: JSContextRef, boolean: bool) -> JSValueRef;
    pub fn JSValueMakeNumber(ctx: JSContextRef, number: f64) -> JSValueRef;
    pub fn JSValueMakeString(ctx: JSContextRef, string: JSStringRef) -> JSValueRef;
    pub fn JSValueToBoolean(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueToNumber(ctx: JSContextRef, value: JSValueRef, exception: *mut JSValueRef) -> f64;
    pub fn JSValueToStringCopy(ctx: JSContextRef, value: JSValueRef, exception: *mut JSValueRef) -> JSStringRef;
    pub fn JSValueToObject(ctx: JSContextRef, value: JSValueRef, exception: *mut JSValueRef) -> JSObjectRef;
    pub fn JSValueProtect(ctx: JSContextRef, value: JSValueRef);
    pub fn JSValueUnprotect(ctx: JSContextRef, value: JSValueRef);

    pub fn JSObjectMake(ctx: JSContextRef, jsClass: JSClassRef, data: *mut c_void) -> JSObjectRef;
    pub fn JSObjectMakeFunctionWithCallback(
        ctx: JSContextRef,
        name: JSStringRef,
        callAsFunction: JSObjectCallAsFunctionCallback,
    ) -> JSObjectRef;
    pub fn JSObjectMakeError(ctx: JSContextRef, argc: usize, argv: *const JSValueRef, exception: *mut JSValueRef) -> JSObjectRef;
    pub fn JSObjectSetProperty(
        ctx: JSContextRef,
        object: JSObjectRef,
        name: JSStringRef,
        value: JSValueRef,
        attributes: JSPropertyAttributes,
        exception: *mut JSValueRef,
    );
    pub fn JSObjectGetProperty(ctx: JSContextRef, object: JSObjectRef, name: JSStringRef, exception: *mut JSValueRef) -> JSValueRef;
    pub fn JSObjectIsFunction(ctx: JSContextRef, object: JSObjectRef) -> bool;
    pub fn JSObjectCallAsFunction(
        ctx: JSContextRef,
        object: JSObjectRef,
        this: JSObjectRef,
        argc: usize,
        argv: *const JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSValueRef;

    pub fn JSObjectMakeTypedArray(ctx: JSContextRef, arrayType: JSTypedArrayType, length: usize, exception: *mut JSValueRef) -> JSObjectRef;
    pub fn JSObjectMakeTypedArrayWithBytesNoCopy(
        ctx: JSContextRef,
        arrayType: JSTypedArrayType,
        bytes: *mut c_void,
        byteLength: usize,
        deallocator: JSTypedArrayBytesDeallocator,
        deallocatorContext: *mut c_void,
        exception: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectGetTypedArrayBytesPtr(ctx: JSContextRef, object: JSObjectRef, exception: *mut JSValueRef) -> *mut c_void;
    pub fn JSObjectGetTypedArrayByteLength(ctx: JSContextRef, object: JSObjectRef, exception: *mut JSValueRef) -> usize;
    pub fn JSObjectGetTypedArrayByteOffset(ctx: JSContextRef, object: JSObjectRef, exception: *mut JSValueRef) -> usize;
    pub fn JSObjectGetArrayBufferBytesPtr(ctx: JSContextRef, object: JSObjectRef, exception: *mut JSValueRef) -> *mut c_void;
    pub fn JSObjectGetArrayBufferByteLength(ctx: JSContextRef, object: JSObjectRef, exception: *mut JSValueRef) -> usize;

    pub fn JSGlobalContextSetUnhandledRejectionCallback(ctx: JSGlobalContextRef, function: JSObjectRef, exception: *mut JSValueRef);

    pub fn JSValueIsBoolean(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsNumber(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsBigInt(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsArray(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueIsStrictEqual(ctx: JSContextRef, a: JSValueRef, b: JSValueRef) -> bool;
    pub fn JSValueToInt64(ctx: JSContextRef, value: JSValueRef, exception: *mut JSValueRef) -> i64;
    pub fn JSBigIntCreateWithInt64(ctx: JSContextRef, integer: i64, exception: *mut JSValueRef) -> JSValueRef;
    pub fn JSBigIntCreateWithUInt64(ctx: JSContextRef, integer: u64, exception: *mut JSValueRef) -> JSValueRef;
    pub fn JSObjectMakeArray(ctx: JSContextRef, argc: usize, argv: *const JSValueRef, exception: *mut JSValueRef) -> JSObjectRef;
    pub fn JSObjectGetPropertyAtIndex(ctx: JSContextRef, object: JSObjectRef, index: c_uint, exception: *mut JSValueRef) -> JSValueRef;
    pub fn JSObjectCallAsConstructor(ctx: JSContextRef, object: JSObjectRef, argc: usize, argv: *const JSValueRef, exception: *mut JSValueRef) -> JSObjectRef;

    // cpp/helpers.cpp
    pub fn bunjsc_create_context() -> JSGlobalContextRef;
    pub fn bunjsc_set_interrupt_handler(ctx: JSContextRef, enabled: bool);
    pub fn bunjsc_import(ctx: JSContextRef, specifier: *const c_char, exception: *mut JSValueRef) -> JSValueRef;
    pub fn bunjsc_evaluate_script(ctx: JSContextRef, source: *const c_char, filename: *const c_char, first_line: c_int, exception: *mut JSValueRef) -> JSValueRef;
    pub fn bunjsc_enter(ctx: JSContextRef);
    pub fn bunjsc_drain_microtasks(ctx: JSContextRef) -> bool;
    pub fn bunjsc_collect_garbage(ctx: JSContextRef);
    pub fn bunjsc_is_error(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn bunjsc_is_detachable_buffer(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn bunjsc_detach_buffer(ctx: JSContextRef, value: JSValueRef);
    pub fn bunjsc_get_async_context(ctx: JSContextRef) -> JSValueRef;
    pub fn bunjsc_set_async_context(ctx: JSContextRef, value: JSValueRef);
    pub fn bunjsc_promise_state(ctx: JSContextRef, value: JSValueRef) -> c_int;
    pub fn bunjsc_promise_result(ctx: JSContextRef, value: JSValueRef) -> JSValueRef;
    pub fn bunjsc_proxy_target(ctx: JSContextRef, value: JSValueRef) -> JSValueRef;
}
