//! Shared-memory backend. The core owns only validated handles and numeric data.
use super::nested_description::{
    Description, Export, Import, ImportKind, Limits, describe, module_record, strings,
};
use super::nested_frame as frame;
use super::nested_invocation::Invocation;
use super::{error, resource_id};
use crate::data::{NativeError, NativeResult, Record, Val};
use std::{cell::RefCell, collections::BTreeMap};
use wasmparser::{Parser, Payload, TypeRef};
#[path = "nested_wire.rs"]
mod wire;
use wire::{BACKEND, Binding, Number, Reply, Request};

pub(super) fn callback_limit() -> usize {
    wire::MAX_RESOURCES
}

pub(super) fn owns(id: u32) -> bool {
    id & BACKEND != 0
}

#[cfg(bun_wasm_shared_group)]
type Dispatch = extern "C" fn(u32, u32, u32) -> u32;
thread_local! {
    #[cfg(bun_wasm_shared_group)]
    static DISPATCH: std::cell::Cell<Option<Dispatch>> = const { std::cell::Cell::new(None) };
    static MODULES: RefCell<BTreeMap<u32, Description>> = const { RefCell::new(BTreeMap::new()) };
    static INSTANCES: RefCell<BTreeMap<u32, InstanceRecord>> = const { RefCell::new(BTreeMap::new()) };
    static FUNCTIONS: RefCell<BTreeMap<u32, Signature>> = const { RefCell::new(BTreeMap::new()) };
    // Wasmtime's table identity is private, so aliases are keyed by instance and export index.
    static TABLES: RefCell<BTreeMap<(u32, u32), u32>> = const { RefCell::new(BTreeMap::new()) };
}

#[derive(Clone, Copy)]
struct InstanceRecord {
    memory: u32,
    module: u32,
}

#[derive(Clone)]
struct Signature {
    params: Vec<String>,
    results: Vec<String>,
}

#[cfg(bun_wasm_shared_group)]
#[unsafe(no_mangle)]
pub extern "C" fn bun_core_bind_nested(dispatch: Dispatch) {
    DISPATCH.with(|entry| {
        assert!(
            entry.replace(Some(dispatch)).is_none(),
            "nested dispatcher already bound"
        )
    });
}

#[cfg(bun_wasm_shared_group)]
#[unsafe(no_mangle)]
pub extern "C" fn bun_nested_dispatch(invocation: u32, callback: u32, pointer: u32) -> u32 {
    let active = super::nested_invocation::active();
    if active != Some(invocation)
        || !crate::split::nested_transport_validate(pointer, frame::FRAME_BYTES)
    {
        return frame::BAD_FRAME;
    }
    let Some(dispatch) = DISPATCH.with(std::cell::Cell::get) else {
        return frame::BAD_FRAME;
    };
    dispatch(invocation, callback, pointer)
}

#[cfg(bun_wasm_shared_group)]
fn exchange(input: &Request) -> Result<Reply, NativeError> {
    #[link(wasm_import_module = "runtime_nested")]
    unsafe extern "C" {
        fn request(pointer: *const u8, length: u32, out: *mut [u32; 2]) -> i32;
    }
    let bytes = serde_json::to_vec(input).map_err(error)?;
    let length = wire::request_length(bytes.len()).ok_or_else(|| error("nested request limit"))?;
    let mut out = [0; 2];
    let status = unsafe { request(bytes.as_ptr(), length, &mut out) };
    if status != 0 {
        return Err(error("nested host transport failed"));
    }
    let bytes = crate::split::nested_transport_read(out[0], out[1]);
    crate::split::bun_core_free(out[0], out[1], 8);
    serde_json::from_slice(&bytes?).map_err(error)
}

fn request(input: Request) -> Result<Reply, NativeError> {
    match exchange(&input)? {
        Reply::Error { category, message } if category == "RangeError" => {
            Err(NativeError::range_error(message))
        }
        Reply::Error { category, message } => Err(NativeError::error(message).named(&category)),
        Reply::PendingException => {
            Err(NativeError::error("engine-side pending exception").named("NestedPendingException"))
        }
        result => Ok(result),
    }
}
fn handle(input: Request) -> Result<u32, NativeError> {
    let Reply::Handle(id) = request(input)? else {
        return Err(error("invalid nested handle reply"));
    };
    if !owns(id) {
        return Err(error("untyped nested handle"));
    }
    Ok(id)
}
fn count(input: Request) -> NativeResult {
    let Reply::Count(value) = request(input)? else {
        return Err(error("invalid nested count reply"));
    };
    Ok(Val::Num(f64::from(value)))
}

pub(super) fn shared(bytes: &[u8]) -> bool {
    Parser::new(0).parse_all(bytes).any(|payload| match payload {
        Ok(Payload::MemorySection(memories)) => memories.into_iter().any(|memory| memory.is_ok_and(|memory| memory.shared)),
        Ok(Payload::ImportSection(imports)) => imports.into_iter().any(|item| matches!(item, Ok(wasmparser::Import { ty: TypeRef::Memory(memory), .. }) if memory.shared)),
        _ => false,
    })
}
pub(super) fn validate(bytes: &[u8]) -> bool {
    let Ok(output) = bunwasm_nested::regionize(bytes) else {
        return false;
    };
    output
        .memory
        .is_some_and(|memory| memory.shared && describe(bytes, limits(&memory)).is_ok())
}
fn limits(memory: &bunwasm_nested::MemoryPlan) -> Limits {
    Limits {
        initial_pages: memory.initial_pages,
        maximum_pages: memory.maximum_pages,
    }
}
pub(super) fn compile(bytes: &[u8]) -> NativeResult {
    if MODULES.with(|modules| modules.borrow().len()) >= wire::MAX_RESOURCES {
        return Err(error("Nested module resource limit"));
    }
    let output = bunwasm_nested::regionize(bytes).map_err(error)?;
    let memory = output
        .memory
        .ok_or_else(|| error("Shared module requires memory"))?;
    if !memory.shared {
        return Err(error("Shared backend cannot import an unshared memory"));
    }
    let description = describe(bytes, limits(&memory))?;
    let id = handle(Request::Compile {
        pointer: output.bytes.as_ptr() as usize as u32,
        length: output.bytes.len() as u32,
    })?;
    let record = module_record(id, &description);
    MODULES.with(|modules| modules.borrow_mut().insert(id, description));
    Ok(record)
}
pub(super) fn publish_memory(memory: u32) -> NativeResult {
    if !owns(memory) {
        return Err(error("Expected a shared WebAssembly.Memory"));
    }
    count(Request::PublishMemory { memory })
}
pub(super) fn attach_memory(token: u32) -> NativeResult {
    Ok(Val::Num(f64::from(handle(Request::AttachMemory {
        token,
    })?)))
}
pub(super) fn publish_module(module: u32) -> NativeResult {
    let description = MODULES
        .with(|modules| modules.borrow().get(&module).cloned())
        .ok_or_else(|| error("Invalid nested module"))?;
    count(Request::PublishModule {
        module,
        description: serde_json::to_string(&description).map_err(error)?,
    })
}
pub(super) fn attach_module(token: u32) -> NativeResult {
    if MODULES.with(|modules| modules.borrow().len()) >= wire::MAX_RESOURCES {
        return Err(error("Nested module resource limit"));
    }
    let Reply::AttachedModule { id, description } = request(Request::AttachModule { token })?
    else {
        return Err(error("invalid nested module reply"));
    };
    if !owns(id) {
        return Err(error("untyped nested handle"));
    }
    let description: Description = serde_json::from_str(&description).map_err(error)?;
    let record = module_record(id, &description);
    MODULES.with(|modules| modules.borrow_mut().insert(id, description));
    Ok(record)
}
pub(super) fn withdraw(token: u32) -> NativeResult {
    count(Request::Withdraw { token })
}
pub(super) fn create_memory(initial: u32, maximum: u32) -> NativeResult {
    Ok(Val::Num(f64::from(handle(Request::Reserve {
        initial,
        maximum,
    })?)))
}
pub(super) fn release_memory(memory: u32) -> NativeResult {
    count(Request::Release { memory })
}
pub(super) fn span(id: u32) -> NativeResult {
    let Reply::Memory {
        pointer,
        pages,
        maximum,
        committed,
    } = request(Request::Span { memory: id })?
    else {
        return Err(error("invalid nested memory reply"));
    };
    Ok(Record::new()
        .set("pointer", pointer)
        .set("length", f64::from(pages) * 65536.0)
        .set("maximum", maximum)
        .set("shared", true)
        .set("generation", Val::BigUint(u64::from(pages)))
        .set("committed", committed as f64)
        .into())
}
pub(super) fn grow(id: u32, delta: u32) -> NativeResult {
    count(Request::Grow { memory: id, delta })
}
fn numbers(args: &[Val], types: &[String]) -> Result<Vec<Number>, NativeError> {
    types
        .iter()
        .enumerate()
        .map(|(index, ty)| numeric(args.get(index).unwrap_or(&Val::Undefined), ty))
        .collect()
}
fn numeric(value: &Val, ty: &str) -> Result<Number, NativeError> {
    match (ty, value) {
        ("i32", Val::Num(n)) => Ok(Number::I32(*n as i32)),
        ("i64", Val::BigInt(n)) => Ok(Number::I64(*n)),
        ("i64", Val::BigUint(n)) => Ok(Number::I64(*n as i64)),
        ("f32", Val::Num(n)) => Ok(Number::F32((*n as f32).to_bits())),
        ("f64", Val::Num(n)) => Ok(Number::F64(n.to_bits())),
        _ => Err(NativeError::type_error(
            "Invalid nested numeric/reference argument",
        )),
    }
}
fn number(value: Number) -> Val {
    match value {
        Number::I32(n) => Val::Num(f64::from(n)),
        Number::I64(n) => Val::BigInt(n),
        Number::F32(n) => Val::Num(f64::from(f32::from_bits(n))),
        Number::F64(n) => Val::Num(f64::from_bits(n)),
    }
}
fn binding(import: &Import, value: &Val) -> Result<Option<Binding>, NativeError> {
    let module = import.module.clone();
    let name = import.name.clone();
    match &import.kind {
        ImportKind::Memory => Ok(None),
        ImportKind::Global(ty) => Ok(Some(Binding::Global {
            module,
            name,
            value: numeric(value, ty)?,
        })),
        ImportKind::Function { .. } => function_binding(module, name, value).map(Some),
    }
}
fn function_binding(module: String, name: String, value: &Val) -> Result<Binding, NativeError> {
    let Val::Object(fields) = value else {
        return Err(error("Missing nested function binding"));
    };
    let kind = fields
        .iter()
        .find(|(key, _)| key == "kind")
        .map(|(_, value)| value);
    let id = fields
        .iter()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value)
        .ok_or_else(|| error("missing callback ID"))?;
    let id = resource_id(id)?;
    match kind {
        Some(Val::Str(kind)) if kind == "callback" => Ok(Binding::Callback { module, name, id }),
        Some(Val::Str(kind)) if kind == "function" && owns(id) => {
            Ok(Binding::Function { module, name, id })
        }
        _ => Err(
            NativeError::type_error("Unsupported mixed-backend function reference")
                .named("LinkError"),
        ),
    }
}

pub(super) fn instantiate(module: u32, values: &[Val], token: u32) -> NativeResult {
    let description = MODULES
        .with(|modules| modules.borrow().get(&module).cloned())
        .ok_or_else(|| error("Invalid nested module"))?;
    if values.len() != description.imports.len() {
        return Err(error("nested import count"));
    }
    let imported = description
        .imports
        .iter()
        .position(|item| matches!(item.kind, ImportKind::Memory));
    let memory = match imported {
        Some(index) => resource_id(&values[index])?,
        None => handle(Request::Reserve {
            initial: description.memory.initial_pages,
            maximum: description
                .memory
                .maximum_pages
                .ok_or_else(|| error("shared maximum"))?,
        })?,
    };
    let result = instantiate_memory(module, memory, &description, values, token);
    if result.is_err() && imported.is_none() {
        let _ = request(Request::Release { memory });
    }
    result
}
fn instantiate_memory(
    module: u32,
    memory: u32,
    description: &Description,
    values: &[Val],
    token: u32,
) -> NativeResult {
    if !owns(memory) {
        return Err(
            NativeError::type_error("Unsupported mixed-backend memory import").named("LinkError"),
        );
    }
    let Reply::Memory { pages, maximum, .. } = request(Request::Span { memory })? else {
        return Err(error("invalid memory import"));
    };
    if pages < description.memory.initial_pages
        || description
            .memory
            .maximum_pages
            .is_some_and(|limit| maximum > limit)
    {
        return Err(error("Incompatible shared memory limits").named("LinkError"));
    }
    let bindings = description
        .imports
        .iter()
        .zip(values)
        .map(|(item, value)| binding(item, value))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();
    let _invocation = Invocation::enter(token)?;
    let id = handle(Request::Instantiate {
        module,
        memory,
        bindings,
        invocation: token,
    })?;
    let record = InstanceRecord { memory, module };
    INSTANCES.with(|instances| instances.borrow_mut().insert(id, record));
    Ok(Val::Num(f64::from(id)))
}
fn instance_record(instance: u32) -> Result<InstanceRecord, NativeError> {
    INSTANCES
        .with(|instances| instances.borrow().get(&instance).copied())
        .ok_or_else(|| error("Invalid nested instance"))
}
pub(super) fn memory_identity(instance: u32) -> NativeResult {
    Ok(Val::Num(f64::from(instance_record(instance)?.memory)))
}
fn remember_function(reply: Reply) -> Result<u32, NativeError> {
    let Reply::Function {
        id,
        params,
        results,
    } = reply
    else {
        return Err(error("invalid nested function reply"));
    };
    let signature = Signature { params, results };
    FUNCTIONS.with(|functions| functions.borrow_mut().insert(id, signature));
    Ok(id)
}
fn signature(function: u32) -> Result<Signature, NativeError> {
    FUNCTIONS
        .with(|functions| functions.borrow().get(&function).cloned())
        .ok_or_else(|| error("Invalid nested function"))
}
pub(super) fn function_info(id: u32) -> NativeResult {
    let signature = signature(id)?;
    Ok(Record::new()
        .set("id", id)
        .set("backend", "nested")
        .set("params", strings(&signature.params))
        .set("results", strings(&signature.results))
        .into())
}
pub(super) fn function(instance: u32, name: &str) -> NativeResult {
    let reply = request(Request::Function {
        instance,
        name: name.to_owned(),
    })?;
    function_info(remember_function(reply)?)
}
fn exported(instance: u32, name: &str, kind: &str) -> Result<Export, NativeError> {
    let module = instance_record(instance)?.module;
    let found = MODULES.with(|modules| {
        let modules = modules.borrow();
        let exports = &modules.get(&module)?.exports;
        exports
            .iter()
            .find(|export| export.name == name && export.kind == kind)
            .cloned()
    });
    found.ok_or_else(|| error(format!("Missing WebAssembly {kind}")))
}
pub(super) fn table_identity(instance: u32, name: &str) -> NativeResult {
    let export = exported(instance, name, "table")?;
    let key = (instance, export.index);
    let known = TABLES.with(|tables| tables.borrow().get(&key).copied());
    let id = match known {
        Some(id) => id,
        None => {
            let name = name.to_owned();
            let id = handle(Request::TableExport { instance, name })?;
            TABLES.with(|tables| tables.borrow_mut().insert(key, id));
            id
        }
    };
    Ok(Record::new()
        .set("id", id)
        .set("backend", "nested")
        .set("element", "funcref")
        .into())
}
pub(super) fn table_length(table: u32) -> NativeResult {
    count(Request::TableLength { table })
}
pub(super) fn table_get(table: u32, index: u32) -> NativeResult {
    match request(Request::TableGet { table, index })? {
        Reply::Null => Ok(Val::Null),
        reply => Ok(super::tagged("function", remember_function(reply)?)),
    }
}
fn table_function(value: &Val) -> Result<Option<u32>, NativeError> {
    if matches!(value, Val::Null) {
        return Ok(None);
    }
    let id = super::handle(value, "function")?;
    if !owns(id) {
        return Err(NativeError::type_error(
            "Unsupported mixed-backend function reference",
        ));
    }
    Ok(Some(id))
}
pub(super) fn table_set(table: u32, index: u32, value: &Val) -> NativeResult {
    let function = table_function(value)?;
    request(Request::TableSet {
        table,
        index,
        function,
    })?;
    Ok(Val::Undefined)
}
pub(super) fn table_grow(table: u32, delta: u32, value: &Val) -> NativeResult {
    let function = table_function(value)?;
    count(Request::TableGrow {
        table,
        delta,
        function,
    })
}
/// Read an exported global, first writing `value` when one is given.
pub(super) fn global(instance: u32, name: &str, value: Option<&Val>) -> NativeResult {
    let export = exported(instance, name, "global")?;
    let name = name.to_owned();
    if let Some(value) = value {
        let ty = export
            .ty
            .as_deref()
            .ok_or_else(|| error("untyped nested global"))?;
        request(Request::GlobalSet {
            instance,
            name: name.clone(),
            value: numeric(value, ty)?,
        })?;
    }
    let Reply::Values(values) = request(Request::GlobalGet { instance, name })? else {
        return Err(error("invalid nested global reply"));
    };
    let value = values
        .into_iter()
        .next()
        .ok_or_else(|| error("invalid nested global reply"))?;
    Ok(number(value))
}
pub(super) fn call(function: u32, values: &[Val], token: u32) -> NativeResult {
    let params = signature(function)?.params;
    let arguments = numbers(values, &params)?;
    let _invocation = Invocation::enter(token)?;
    let Reply::Values(values) = request(Request::Call {
        function,
        arguments,
        invocation: token,
    })?
    else {
        return Err(error("invalid nested call reply"));
    };
    Ok(Record::new()
        .set("values", values.into_iter().map(number).collect::<Vec<_>>())
        .into())
}
