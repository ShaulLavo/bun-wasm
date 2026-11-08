//! Shared-memory backend. The core owns only validated handles and numeric data.
use super::nested_frame as frame;
use super::nested_invocation::Invocation;
use super::{error, resource_id};
use crate::data::{NativeError, NativeResult, Record, Val};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::BTreeMap};
use wasmparser::{ExternalKind, Parser, Payload, TypeRef, ValType};
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
    static INSTANCES: RefCell<BTreeMap<u32, u32>> = const { RefCell::new(BTreeMap::new()) };
    static FUNCTIONS: RefCell<BTreeMap<u32, Vec<String>>> = const { RefCell::new(BTreeMap::new()) };
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
    let mut out = [0; 2];
    let status = unsafe { request(bytes.as_ptr(), bytes.len() as u32, &mut out) };
    if status != 0 {
        return Err(error("nested host transport failed"));
    }
    let bytes = crate::split::nested_transport_read(out[0], out[1]);
    crate::split::bun_core_free(out[0], out[1], 8);
    serde_json::from_slice(&bytes?).map_err(error)
}

fn request(input: Request) -> Result<Reply, NativeError> {
    match exchange(&input)? {
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

#[derive(Clone, Serialize, Deserialize)]
struct Import {
    module: String,
    name: String,
    kind: ImportKind,
}
#[derive(Clone, Serialize, Deserialize)]
enum ImportKind {
    Function {
        params: Vec<String>,
        results: Vec<String>,
    },
    Memory,
    Global(String),
}
#[derive(Clone, Serialize, Deserialize)]
struct Export {
    name: String,
    kind: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Limits {
    initial_pages: u32,
    maximum_pages: Option<u32>,
}
/// A compiled module's JS-visible shape. The directory carries it opaquely between members
/// of one group, which already share every byte, so it needs no second validation.
#[derive(Clone, Serialize, Deserialize)]
struct Description {
    memory: Limits,
    imports: Vec<Import>,
    exports: Vec<Export>,
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
        .is_some_and(|memory| memory.shared && describe(bytes, &memory).is_ok())
}
fn type_name(ty: ValType) -> Result<String, NativeError> {
    Ok(match ty {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::V128 => "v128",
        ValType::Ref(_) => return Err(error("Unsupported nested reference boundary")),
    }
    .to_owned())
}
fn strings(types: &[String]) -> Val {
    Val::Array(
        types
            .iter()
            .map(|value| Val::from(value.as_str()))
            .collect(),
    )
}
fn import_description(import: &Import) -> Val {
    let base = Record::new()
        .set("module", import.module.as_str())
        .set("name", import.name.as_str());
    match &import.kind {
        ImportKind::Function { params, results } => base
            .set("kind", "function")
            .set("params", strings(params))
            .set("results", strings(results))
            .into(),
        ImportKind::Memory => base.set("kind", "memory").into(),
        ImportKind::Global(ty) => base
            .set("kind", "global")
            .set("type", ty.as_str())
            .set("mutable", false)
            .into(),
    }
}
fn describe(bytes: &[u8], memory: &bunwasm_nested::MemoryPlan) -> Result<Description, NativeError> {
    let memory = Limits {
        initial_pages: memory.initial_pages,
        maximum_pages: memory.maximum_pages,
    };
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut types = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(error)? {
            Payload::TypeSection(section) => describe_types(section, &mut types)?,
            Payload::ImportSection(section) => describe_imports(section, &types, &mut imports)?,
            Payload::ExportSection(section) => describe_exports(section, &mut exports)?,
            _ => {}
        }
    }
    Ok(Description {
        memory,
        imports,
        exports,
    })
}
fn describe_types(
    section: wasmparser::TypeSectionReader<'_>,
    types: &mut Vec<wasmparser::FuncType>,
) -> Result<(), NativeError> {
    for ty in section.into_iter_err_on_gc_types() {
        types.push(ty.map_err(error)?);
    }
    Ok(())
}
fn describe_imports(
    section: wasmparser::ImportSectionReader<'_>,
    types: &[wasmparser::FuncType],
    imports: &mut Vec<Import>,
) -> Result<(), NativeError> {
    for item in section {
        imports.push(describe_import(item.map_err(error)?, types)?);
    }
    Ok(())
}
fn describe_exports(
    section: wasmparser::ExportSectionReader<'_>,
    exports: &mut Vec<Export>,
) -> Result<(), NativeError> {
    for item in section {
        exports.push(describe_export(item.map_err(error)?)?);
    }
    Ok(())
}
fn describe_import(
    item: wasmparser::Import<'_>,
    types: &[wasmparser::FuncType],
) -> Result<Import, NativeError> {
    let kind = match item.ty {
        TypeRef::Memory(_) => ImportKind::Memory,
        TypeRef::Func(index) => {
            let ty = types
                .get(index as usize)
                .ok_or_else(|| error("invalid nested function type"))?;
            ImportKind::Function {
                params: ty
                    .params()
                    .iter()
                    .copied()
                    .map(type_name)
                    .collect::<Result<_, _>>()?,
                results: ty
                    .results()
                    .iter()
                    .copied()
                    .map(type_name)
                    .collect::<Result<_, _>>()?,
            }
        }
        TypeRef::Global(global) if !global.mutable => {
            ImportKind::Global(type_name(global.content_type)?)
        }
        _ => return Err(error("Unsupported nested import kind")),
    };
    Ok(Import {
        module: item.module.to_owned(),
        name: item.name.to_owned(),
        kind,
    })
}
fn describe_export(item: wasmparser::Export<'_>) -> Result<Export, NativeError> {
    let kind = match item.kind {
        ExternalKind::Func => "function",
        ExternalKind::Memory => "memory",
        _ => {
            return Err(error(
                "Nested tables/globals are not yet exposed by this milestone",
            ));
        }
    };
    Ok(Export {
        name: item.name.to_owned(),
        kind: kind.to_owned(),
    })
}
fn module_record(id: u32, description: &Description) -> Val {
    let imports: Vec<_> = description.imports.iter().map(import_description).collect();
    let exports: Vec<Val> = description
        .exports
        .iter()
        .map(|export| {
            Record::new()
                .set("name", export.name.as_str())
                .set("kind", export.kind.as_str())
                .into()
        })
        .collect();
    Record::new()
        .set("id", id)
        .set("backend", "nested")
        .set("imports", imports)
        .set("exports", exports)
        .into()
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
    let description = describe(bytes, &memory)?;
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
    INSTANCES.with(|instances| instances.borrow_mut().insert(id, memory));
    Ok(Val::Num(f64::from(id)))
}
pub(super) fn memory_identity(instance: u32) -> NativeResult {
    let id = INSTANCES
        .with(|instances| instances.borrow().get(&instance).copied())
        .ok_or_else(|| error("Invalid nested instance"))?;
    Ok(Val::Num(f64::from(id)))
}
pub(super) fn function(instance: u32, name: &str) -> NativeResult {
    let Reply::Function {
        id,
        params,
        results,
    } = request(Request::Function {
        instance,
        name: name.to_owned(),
    })?
    else {
        return Err(error("invalid nested function reply"));
    };
    FUNCTIONS.with(|functions| functions.borrow_mut().insert(id, params.clone()));
    Ok(Record::new()
        .set("id", id)
        .set("backend", "nested")
        .set("params", strings(&params))
        .set("results", strings(&results))
        .into())
}
pub(super) fn call(function: u32, values: &[Val], token: u32) -> NativeResult {
    let params = FUNCTIONS
        .with(|functions| functions.borrow().get(&function).cloned())
        .ok_or_else(|| error("Invalid nested function"))?;
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
