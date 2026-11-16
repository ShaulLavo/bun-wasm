#[cfg(bun_wasm_shared_group)]
mod nested;
#[cfg(any(test, bun_wasm_shared_group))]
#[path = "wasm/nested_frame.rs"]
mod nested_frame;
#[cfg(any(test, bun_wasm_shared_group))]
#[path = "wasm/nested_invocation.rs"]
mod nested_invocation;

#[cfg(bun_wasm_shared_group)]
mod group;
// Visible to the crate for `lane_allocation_tests`, which the crate root declares.
#[cfg(any(test, bun_wasm_shared_group))]
#[path = "wasm/lane.rs"]
pub(crate) mod lane;
#[cfg(any(test, bun_wasm_shared_group))]
#[path = "wasm/nested_description.rs"]
mod nested_description;
#[cfg(any(test, bun_wasm_shared_group))]
#[path = "wasm/shared_buffer.rs"]
mod shared_buffer;

use std::{
    cell::RefCell,
    collections::BTreeMap,
    fmt,
    rc::Rc,
    sync::atomic::{AtomicU32, Ordering},
};

use wasmi::{
    CompilationMode, Config, Engine, ExternRef, ExternType, Func, FuncRef, Global, Instance,
    Memory, MemoryType, Module, ResumableCall, ResumableCallHostTrap, Store, Table as WasmTable,
    TableType, Val as WVal,
    core::{HostError, Mutability, ValType},
};

use crate::{
    data::{NativeError, NativeResult, Record, Val},
    natives::Table,
};

const COMPILATION_MODE: CompilationMode = CompilationMode::LazyTranslation;

#[derive(Debug)]
struct ImportCall {
    callback: u32,
    args: Vec<WVal>,
}
impl fmt::Display for ImportCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "WebAssembly import {}", self.callback)
    }
}
impl HostError for ImportCall {}

enum Suspended {
    Wasm {
        invocation: ResumableCallHostTrap,
        outputs: Vec<WVal>,
    },
    Host {
        results: Vec<ValType>,
    },
}
struct Guest {
    instance: Instance,
    global_exports: BTreeMap<String, u32>,
    globals: BTreeMap<u32, u32>,
}
#[derive(Clone, Copy)]
struct GlobalResource {
    global: Global,
    constructor: bool,
}
// A namespace, never a root. Each registry and all its backend objects die with its Store.
static NEXT_GLOBAL_STORE: AtomicU32 = AtomicU32::new(1);
struct Runtime {
    engine: Engine,
    store: Store<()>,
    modules: Vec<Module>,
    guests: Vec<Guest>,
    memories: Vec<Memory>,
    tables: Vec<WasmTable>,
    functions: Vec<Func>,
    global_store: u32,
    globals: Vec<GlobalResource>,
    module_global_exports: BTreeMap<u32, BTreeMap<String, u32>>,
    references: BTreeMap<u32, ExternRef>,
    calls: BTreeMap<u32, Suspended>,
    next_call: u32,
}
impl Default for Runtime {
    fn default() -> Self {
        let mut config = Config::default();
        config.compilation_mode(COMPILATION_MODE);
        let engine = Engine::new(&config);
        let store = Store::new(&engine, ());
        Self {
            engine,
            store,
            modules: Vec::new(),
            guests: Vec::new(),
            memories: Vec::new(),
            tables: Vec::new(),
            functions: Vec::new(),
            global_store: NEXT_GLOBAL_STORE.fetch_add(1, Ordering::Relaxed),
            globals: Vec::new(),
            module_global_exports: BTreeMap::new(),
            references: BTreeMap::new(),
            calls: BTreeMap::new(),
            next_call: 0,
        }
    }
}

fn error(error: impl fmt::Display) -> NativeError {
    NativeError::error(error.to_string())
}
fn kind(ty: &ExternType) -> &'static str {
    match ty {
        ExternType::Func(_) => "function",
        ExternType::Memory(_) => "memory",
        ExternType::Global(_) => "global",
        ExternType::Table(_) => "table",
    }
}
fn value_type(ty: &ValType) -> Val {
    Val::from(match ty {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::FuncRef => "funcref",
        ValType::ExternRef => "externref",
        ValType::V128 => "v128",
    })
}
fn describe(record: Record, ty: &ExternType) -> Record {
    let record = record.set("kind", kind(ty));
    match ty {
        ExternType::Func(ty) => record
            .set(
                "params",
                ty.params().iter().map(value_type).collect::<Vec<_>>(),
            )
            .set(
                "results",
                ty.results().iter().map(value_type).collect::<Vec<_>>(),
            ),
        ExternType::Global(ty) => record
            .set("type", value_type(&ty.content()))
            .set("mutable", ty.mutability().is_mut()),
        ExternType::Table(ty) => record.set("element", value_type(&ty.element())),
        _ => record,
    }
}
fn tagged(kind: &str, id: u32) -> Val {
    Record::new().set("kind", kind).set("id", id).into()
}
fn handle(value: &Val, expected: &str) -> Result<u32, NativeError> {
    let Val::Object(fields) = value else {
        return Err(NativeError::type_error(
            "Expected WebAssembly reference handle",
        ));
    };
    let kind = fields
        .iter()
        .find(|(key, _)| key == "kind")
        .map(|(_, value)| value);
    let id = fields
        .iter()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value);
    if kind != Some(&Val::from(expected)) {
        return Err(NativeError::type_error(
            "Invalid WebAssembly reference kind",
        ));
    }
    resource_id(id.unwrap_or(&Val::Undefined))
}
fn resource_id(value: &Val) -> Result<u32, NativeError> {
    let Val::Num(value) = value else {
        return Err(NativeError::type_error("Expected WebAssembly resource ID"));
    };
    if !value.is_finite() || *value < 0.0 || *value > u32::MAX as f64 || value.fract() != 0.0 {
        return Err(NativeError::type_error("Invalid WebAssembly resource ID"));
    }
    Ok(*value as u32)
}
fn field<'a>(value: &'a Val, name: &str) -> Option<&'a Val> {
    let Val::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}
fn global_exports(bytes: &[u8]) -> Result<BTreeMap<String, u32>, NativeError> {
    let mut exports = BTreeMap::new();
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let wasmparser::Payload::ExportSection(section) = payload.map_err(error)? else {
            continue;
        };
        add_global_exports(section, &mut exports)?;
    }
    Ok(exports)
}
fn add_global_exports(
    section: wasmparser::ExportSectionReader<'_>,
    exports: &mut BTreeMap<String, u32>,
) -> Result<(), NativeError> {
    for item in section {
        let item = item.map_err(error)?;
        if item.kind == wasmparser::ExternalKind::Global {
            exports.insert(item.name.to_owned(), item.index);
        }
    }
    Ok(())
}
impl Guest {
    fn memory(&self, store: &Store<()>, name: &str) -> Result<Memory, NativeError> {
        self.instance
            .get_memory(store, name)
            .ok_or_else(|| error("Missing WebAssembly memory"))
    }
}
impl Runtime {
    fn global_handle(&self, binding: &Val) -> Result<u32, NativeError> {
        let id = handle(binding, "global")?;
        if field(binding, "backend") != Some(&Val::from("wasmi"))
            || field(binding, "store") != Some(&Val::Num(self.global_store as f64))
        {
            return Err(error(
                "WebAssembly global belongs to another backend or member Store",
            ));
        }
        let resource = self.global_resource(id)?;
        let ty = resource.global.ty(&self.store);
        if field(binding, "type") != Some(&value_type(&ty.content()))
            || field(binding, "mutable") != Some(&Val::Bool(ty.mutability().is_mut()))
        {
            return Err(error("Invalid WebAssembly global metadata"));
        }
        Ok(id)
    }
    fn global_resource(&self, id: u32) -> Result<GlobalResource, NativeError> {
        self.globals
            .get(id as usize)
            .copied()
            .ok_or_else(|| error("Invalid WebAssembly global handle"))
    }
    fn global_info(&self, id: u32) -> NativeResult {
        let resource = self.global_resource(id)?;
        let ty = resource.global.ty(&self.store);
        Ok(Record::new()
            .set("kind", "global")
            .set("backend", "wasmi")
            .set("store", self.global_store)
            .set("id", id)
            .set("type", value_type(&ty.content()))
            .set("mutable", ty.mutability().is_mut())
            .set(
                "origin",
                if resource.constructor {
                    "constructor"
                } else {
                    "export"
                },
            )
            .into())
    }
    fn register_global(&mut self, global: Global, constructor: bool) -> u32 {
        let id = self.globals.len() as u32;
        self.globals.push(GlobalResource {
            global,
            constructor,
        });
        id
    }
    fn create_global(&mut self, ty: &str, mutable: bool, value: &Val) -> NativeResult {
        let ty = match ty {
            "i32" => ValType::I32,
            "i64" => ValType::I64,
            "f32" => ValType::F32,
            "f64" => ValType::F64,
            _ => {
                return Err(NativeError::type_error(
                    "Unsupported WebAssembly global type",
                ));
            }
        };
        let value = self.wasm(value, ty)?;
        let mutability = if mutable {
            Mutability::Var
        } else {
            Mutability::Const
        };
        let global = Global::new(&mut self.store, value, mutability);
        let id = self.register_global(global, true);
        self.global_info(id)
    }
    fn global_identity(&mut self, instance: u32, name: &str) -> NativeResult {
        let guest = self.guest(instance)?;
        let index = *guest
            .global_exports
            .get(name)
            .ok_or_else(|| error("Missing WebAssembly global declaration"))?;
        if let Some(id) = guest.globals.get(&index) {
            return self.global_info(*id);
        }
        let global = guest
            .instance
            .get_global(&self.store, name)
            .ok_or_else(|| error("Missing WebAssembly global"))?;
        let id = self.register_global(global, false);
        self.guests[instance as usize].globals.insert(index, id);
        self.global_info(id)
    }
    fn global_value(&mut self, binding: &Val, value: Option<&Val>) -> NativeResult {
        let id = self.global_handle(binding)?;
        let global = self.global_resource(id)?.global;
        if let Some(value) = value {
            let ty = global.ty(&self.store);
            if !ty.mutability().is_mut() {
                return Err(NativeError::type_error("Immutable WebAssembly global"));
            }
            let value = self.wasm(value, ty.content())?;
            global.set(&mut self.store, value).map_err(error)?;
        }
        self.js(&global.get(&self.store))
    }
    fn scalar_global_import(&mut self, binding: &Val) -> NativeResult {
        let id = self.global_handle(binding)?;
        let resource = self.global_resource(id)?;
        if resource.constructor {
            return Err(
                error("Constructor-created WebAssembly globals cannot cross backends")
                    .named("LinkError"),
            );
        }
        let ty = resource.global.ty(&self.store);
        if ty.mutability().is_mut()
            || !matches!(
                ty.content(),
                ValType::I32 | ValType::I64 | ValType::F32 | ValType::F64
            )
        {
            return Err(error(
                "Only immutable exported numeric WebAssembly globals can cross backends",
            )
            .named("LinkError"));
        }
        self.global_value(binding, None)
    }
    fn import_global(
        &mut self,
        ty: &wasmi::core::GlobalType,
        binding: &Val,
    ) -> Result<Global, NativeError> {
        if matches!(binding, Val::Object(_)) {
            let id = self.global_handle(binding)?;
            let global = self.global_resource(id)?.global;
            if global.ty(&self.store) != *ty {
                return Err(error("Incompatible WebAssembly global import"));
            }
            return Ok(global);
        }
        if ty.mutability().is_mut() {
            return Err(error("Mutable WebAssembly global import requires a Global"));
        }
        if !matches!(
            ty.content(),
            ValType::I32 | ValType::I64 | ValType::F32 | ValType::F64
        ) {
            return Err(error("Unsupported WebAssembly global import type"));
        }
        let value = self.wasm(binding, ty.content())?;
        Ok(Global::new(&mut self.store, value, Mutability::Const))
    }
    fn imported_global_ids(
        &self,
        module: &Module,
        bindings: &[Val],
    ) -> Result<BTreeMap<u32, u32>, NativeError> {
        let mut globals = BTreeMap::new();
        let mut ordinal = 0;
        for (index, import) in module.imports().enumerate() {
            if !matches!(import.ty(), ExternType::Global(_)) {
                continue;
            }
            let binding = bindings.get(index).unwrap_or(&Val::Undefined);
            if matches!(binding, Val::Object(_)) {
                globals.insert(ordinal, self.global_handle(binding)?);
            }
            ordinal += 1;
        }
        Ok(globals)
    }
    fn js(&mut self, value: &WVal) -> Result<Val, NativeError> {
        Ok(match value {
            WVal::V128(_) => {
                return Err(NativeError::type_error(
                    "WebAssembly v128 cannot cross the JavaScript boundary",
                ));
            }
            WVal::I32(n) => Val::Num(*n as f64),
            WVal::I64(n) => Val::BigInt(*n),
            WVal::F32(n) => Val::Num(f32::from(*n) as f64),
            WVal::F64(n) => Val::Num(f64::from(*n)),
            WVal::FuncRef(reference) => match reference.func() {
                Some(function) => tagged("function", self.intern_function(*function)),
                None => Val::Null,
            },
            WVal::ExternRef(reference) => match reference.data(&self.store) {
                Some(data) => tagged(
                    "externref",
                    *data
                        .downcast_ref::<u32>()
                        .ok_or_else(|| error("Foreign externref payload"))?,
                ),
                None => Val::Null,
            },
        })
    }
    fn wasm(&mut self, value: &Val, ty: ValType) -> Result<WVal, NativeError> {
        match (ty, value) {
            (ValType::I32, Val::Num(n)) => Ok(WVal::I32(*n as i32)),
            (ValType::I64, Val::BigInt(n)) => Ok(WVal::I64(*n)),
            (ValType::I64, Val::BigUint(n)) => Ok(WVal::I64(*n as i64)),
            (ValType::F32, Val::Num(n)) => Ok(WVal::F32((*n as f32).into())),
            (ValType::F64, Val::Num(n)) => Ok(WVal::F64((*n).into())),
            (ValType::FuncRef, Val::Null) => Ok(WVal::FuncRef(FuncRef::null())),
            (ValType::ExternRef, Val::Null) => Ok(WVal::ExternRef(ExternRef::null())),
            (ValType::FuncRef, _) => Ok(WVal::FuncRef(
                self.function(handle(value, "function")?)?.into(),
            )),
            (ValType::ExternRef, _) => {
                let id = handle(value, "externref")?;
                Ok(WVal::ExternRef(self.externref(id)))
            }
            _ => Err(NativeError::type_error("Invalid WebAssembly argument")),
        }
    }
    fn externref(&mut self, id: u32) -> ExternRef {
        *self
            .references
            .entry(id)
            .or_insert_with(|| ExternRef::new(&mut self.store, id))
    }
    fn values(&mut self, args: &[Val], types: &[ValType]) -> Result<Vec<WVal>, NativeError> {
        types
            .iter()
            .enumerate()
            .map(|(i, ty)| self.wasm(args.get(i).unwrap_or(&Val::Undefined), *ty))
            .collect()
    }
    fn completed(&mut self, outputs: &[WVal]) -> NativeResult {
        let values = outputs
            .iter()
            .map(|value| self.js(value))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Record::new().set("values", values).into())
    }
    fn suspend(&mut self, callback: u32, args: &[WVal], pending: Suspended) -> NativeResult {
        let id = self.next_call;
        self.next_call = id
            .checked_add(1)
            .ok_or_else(|| error("WebAssembly call ID exhausted"))?;
        let args = args
            .iter()
            .map(|value| self.js(value))
            .collect::<Result<Vec<_>, _>>()?;
        self.calls.insert(id, pending);
        Ok(Record::new()
            .set("call", id)
            .set("import", callback)
            .set("args", args)
            .into())
    }
    fn finish(&mut self, result: ResumableCall, outputs: Vec<WVal>) -> NativeResult {
        let ResumableCall::HostTrap(invocation) = result else {
            if matches!(result, ResumableCall::OutOfFuel(_)) {
                return Err(error("WebAssembly fuel exhausted"));
            }
            return self.completed(&outputs);
        };
        let import = invocation
            .host_error()
            .downcast_ref::<ImportCall>()
            .ok_or_else(|| error(invocation.host_error()))?;
        let callback = import.callback;
        let args = import.args.clone();
        self.suspend(
            callback,
            &args,
            Suspended::Wasm {
                invocation,
                outputs,
            },
        )
    }
    fn call(&mut self, id: u32, args: &[Val]) -> NativeResult {
        let function = self.function(id)?;
        let ty = function.ty(&self.store);
        let inputs = self.values(args, ty.params())?;
        let mut outputs: Vec<_> = ty.results().iter().copied().map(WVal::default).collect();
        match function.call_resumable(&mut self.store, &inputs, &mut outputs) {
            Ok(result) => self.finish(result, outputs),
            Err(failure) => {
                let import = failure
                    .downcast_ref::<ImportCall>()
                    .ok_or_else(|| error(&failure))?;
                self.suspend(
                    import.callback,
                    &import.args,
                    Suspended::Host {
                        results: ty.results().to_vec(),
                    },
                )
            }
        }
    }
    fn resume(&mut self, id: u32, args: &[Val]) -> NativeResult {
        let pending = self
            .calls
            .remove(&id)
            .ok_or_else(|| error("Invalid WebAssembly call"))?;
        match pending {
            Suspended::Host { results } => {
                let outputs = self.values(args, &results)?;
                self.completed(&outputs)
            }
            Suspended::Wasm {
                invocation,
                mut outputs,
            } => {
                let ty = invocation.host_func().ty(&self.store);
                let inputs = self.values(args, ty.results())?;
                let result = invocation
                    .resume(&mut self.store, &inputs, &mut outputs)
                    .map_err(error)?;
                self.finish(result, outputs)
            }
        }
    }

    fn guest(&self, id: u32) -> Result<&Guest, NativeError> {
        self.guests
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))
    }
    fn compile(&mut self, bytes: &[u8]) -> NativeResult {
        let module = Module::new(&self.engine, bytes).map_err(error)?;
        let global_exports = global_exports(bytes)?;
        let imports: Vec<Val> = module
            .imports()
            .map(|i| {
                describe(
                    Record::new()
                        .set("module", i.module())
                        .set("name", i.name()),
                    i.ty(),
                )
                .into()
            })
            .collect();
        let exports: Vec<Val> = module
            .exports()
            .map(|i| {
                let mut record = describe(Record::new().set("name", i.name()), i.ty());
                if let Some(index) = global_exports.get(i.name()) {
                    record = record.set("index", *index);
                }
                record.into()
            })
            .collect();
        let id = self.modules.len();
        self.modules.push(module);
        self.module_global_exports.insert(id as u32, global_exports);
        Ok(Record::new()
            .set("id", id as u32)
            .set("imports", imports)
            .set("exports", exports)
            .into())
    }
    fn memory_id(&self, value: &Val) -> Result<u32, NativeError> {
        let id = resource_id(value)?;
        self.memory(id)?;
        Ok(id)
    }
    fn memory(&self, id: u32) -> Result<Memory, NativeError> {
        self.memories
            .get(id as usize)
            .copied()
            .ok_or_else(|| error("Invalid WebAssembly memory"))
    }
    fn intern_memory(&mut self, memory: Memory) -> u32 {
        if let Some(id) = self.memories.iter().position(|item| *item == memory) {
            return id as u32;
        }
        let id = self.memories.len() as u32;
        self.memories.push(memory);
        id
    }
    /// Where a memory's bytes sit in this process's linear memory, their length, and the
    /// growth generation they belong to. The store keeps every interned memory until the
    /// session ends. Only growth can move or resize the bytes, and each successful growth,
    /// including by zero pages, advances the generation.
    fn memory_span(&self, id: u32) -> NativeResult {
        let memory = self.memory(id)?;
        let data = memory.data(&self.store);
        Ok(Record::new()
            .set("pointer", data.as_ptr() as usize as f64)
            .set("length", data.len() as f64)
            .set(
                "generation",
                Val::BigUint(memory.growth_generation(&self.store)),
            )
            .into())
    }
    fn create_memory(&mut self, minimum: u32, maximum: Option<u32>) -> NativeResult {
        let mut builder = MemoryType::builder();
        builder.min(u64::from(minimum));
        builder.max(maximum.map(u64::from));
        let ty = builder.build().map_err(error)?;
        let memory = Memory::new(&mut self.store, ty).map_err(error)?;
        Ok(Val::Num(self.intern_memory(memory) as f64))
    }
    fn function(&self, id: u32) -> Result<Func, NativeError> {
        self.functions
            .get(id as usize)
            .copied()
            .ok_or_else(|| error("Invalid WebAssembly function"))
    }
    fn intern_function(&mut self, function: Func) -> u32 {
        if let Some(id) = self.functions.iter().position(|item| *item == function) {
            return id as u32;
        }
        let id = self.functions.len() as u32;
        self.functions.push(function);
        id
    }
    fn function_info(&self, id: u32) -> NativeResult {
        let ty = self.function(id)?.ty(&self.store);
        Ok(describe(Record::new().set("id", id), &ExternType::Func(ty)).into())
    }
    fn table(&self, id: u32) -> Result<WasmTable, NativeError> {
        self.tables
            .get(id as usize)
            .copied()
            .ok_or_else(|| error("Invalid WebAssembly table"))
    }
    fn intern_table(&mut self, table: WasmTable) -> u32 {
        if let Some(id) = self.tables.iter().position(|item| *item == table) {
            return id as u32;
        }
        let id = self.tables.len() as u32;
        self.tables.push(table);
        id
    }
    fn table_info(&self, id: u32) -> NativeResult {
        let table = self.table(id)?;
        Ok(Record::new()
            .set("id", id)
            .set("element", value_type(&table.ty(&self.store).element()))
            .into())
    }
    fn import_function(
        &mut self,
        ty: &wasmi::FuncType,
        binding: &Val,
    ) -> Result<Func, NativeError> {
        if let Ok(id) = handle(binding, "function") {
            return self.function(id);
        }
        let callback = handle(binding, "callback")?;
        Ok(Func::new(&mut self.store, ty.clone(), move |_, args, _| {
            Err(wasmi::Error::host(ImportCall {
                callback,
                args: args.to_vec(),
            }))
        }))
    }
    fn import(&mut self, ty: &ExternType, binding: &Val) -> Result<wasmi::Extern, NativeError> {
        match ty {
            ExternType::Func(ty) => Ok(self.import_function(ty, binding)?.into()),
            ExternType::Memory(_) => Ok(self.memory(self.memory_id(binding)?)?.into()),
            ExternType::Table(_) => Ok(self.table(resource_id(binding)?)?.into()),
            ExternType::Global(ty) => Ok(self.import_global(ty, binding)?.into()),
        }
    }
    fn instantiate(&mut self, id: u32, bindings: &[Val]) -> NativeResult {
        let module = self
            .modules
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly module"))?
            .clone();
        let imports = module
            .imports()
            .enumerate()
            .map(|(index, import)| {
                self.import(import.ty(), bindings.get(index).unwrap_or(&Val::Undefined))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let globals = self.imported_global_ids(&module, bindings)?;
        let instance = Instance::new(&mut self.store, &module, &imports).map_err(error)?;
        let memories: Vec<_> = instance
            .exports(&self.store)
            .filter_map(|export| export.into_memory())
            .collect();
        for memory in memories {
            self.intern_memory(memory);
        }
        let global_exports = self
            .module_global_exports
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let instance_id = self.guests.len();
        self.guests.push(Guest {
            instance,
            global_exports,
            globals,
        });
        Ok(Val::Num(instance_id as f64))
    }
}

/// Same-region transport between members of one group. Only the shared-group polyfill calls it.
#[cfg(bun_wasm_shared_group)]
fn install_group_transport(table: &mut Table) {
    table.add("wasm.publishSharedMemory", |a| {
        nested::publish_memory(a.u32(0)?)
    });
    table.add("wasm.attachSharedMemory", |a| {
        nested::attach_memory(a.u32(0)?)
    });
    table.add("wasm.publishSharedModule", |a| {
        nested::publish_module(a.u32(0)?)
    });
    table.add("wasm.attachSharedModule", |a| {
        nested::attach_module(a.u32(0)?)
    });
    table.add("wasm.withdrawShared", |a| nested::withdraw(a.u32(0)?));
    lane::guest::install(table);
}

pub fn install(table: &mut Table) {
    #[cfg(bun_wasm_shared_group)]
    install_group_transport(table);
    table.add("wasm.sharedMemorySupported", |_| {
        Ok(Val::Bool(cfg!(bun_wasm_shared_group)))
    });
    table.add("wasm.nestedCallbackLimit", |_| {
        #[cfg(bun_wasm_shared_group)]
        {
            Ok(Val::Num(nested::callback_limit() as f64))
        }
        #[cfg(not(bun_wasm_shared_group))]
        {
            Err(error(
                "Shared WebAssembly memories require the shared-group profile",
            ))
        }
    });
    table.add("wasm.createSharedMemory", move |a| {
        #[cfg(bun_wasm_shared_group)]
        {
            nested::create_memory(a.u32(0)?, a.u32(1)?)
        }
        #[cfg(not(bun_wasm_shared_group))]
        {
            let _ = a;
            Err(error(
                "Shared WebAssembly memories require the shared-group profile",
            ))
        }
    });
    let runtime = Rc::new(RefCell::new(Runtime::default()));
    let rt = runtime.clone();
    table.add("wasm.validate", move |a| {
        let bytes = a.bytes(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::shared(bytes) {
            return Ok(Val::Bool(nested::validate(bytes)));
        }
        Ok(Val::Bool(
            Module::validate(&rt.borrow().engine, bytes).is_ok(),
        ))
    });
    let rt = runtime.clone();
    table.add("wasm.compile", move |a| {
        let bytes = a.bytes(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::shared(bytes) {
            return nested::compile(bytes);
        }
        rt.borrow_mut().compile(bytes)
    });
    let rt = runtime.clone();
    table.add("wasm.instantiate", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::instantiate(id, a.array(1).unwrap_or(&[]), a.u32(2)?);
        }
        rt.borrow_mut().instantiate(id, a.array(1).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.createMemory", move |a| {
        let maximum = if a.is_missing(1) {
            None
        } else {
            Some(a.u32(1)?)
        };
        rt.borrow_mut().create_memory(a.u32(0)?, maximum)
    });
    let rt = runtime.clone();
    table.add("wasm.call", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::call(id, a.array(1).unwrap_or(&[]), a.u32(2)?);
        }
        rt.borrow_mut().call(id, a.array(1).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.resume", move |a| {
        rt.borrow_mut().resume(a.u32(0)?, a.array(1).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.cancel", move |a| {
        rt.borrow_mut().calls.remove(&a.u32(0)?);
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.functionIdentity", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::function(id, a.str(1)?);
        }
        let mut rt = rt.borrow_mut();
        let function = rt
            .guest(id)?
            .instance
            .get_func(&rt.store, a.str(1)?)
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        let id = rt.intern_function(function);
        rt.function_info(id)
    });
    let rt = runtime.clone();
    table.add("wasm.functionInfo", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::function_info(id);
        }
        rt.borrow().function_info(id)
    });
    let rt = runtime.clone();
    table.add("wasm.createTable", move |a| {
        let mut rt = rt.borrow_mut();
        let element = match a.str(0)? {
            "funcref" => ValType::FuncRef,
            "externref" => ValType::ExternRef,
            _ => return Err(NativeError::type_error("Invalid WebAssembly table element")),
        };
        let minimum = a.u32(1)?;
        let maximum = if a.is_missing(2) {
            None
        } else {
            Some(a.u32(2)?)
        };
        if maximum.is_some_and(|maximum| maximum < minimum) {
            return Err(NativeError::range_error(
                "WebAssembly table maximum is smaller than initial",
            ));
        }
        let init = rt.wasm(a.get(3), element)?;
        let table = WasmTable::new(
            &mut rt.store,
            TableType::new(element, minimum, maximum),
            init,
        )
        .map_err(error)?;
        let id = rt.intern_table(table);
        rt.table_info(id)
    });
    let rt = runtime.clone();
    table.add("wasm.tableIdentity", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::table_identity(id, a.str(1)?);
        }
        let mut rt = rt.borrow_mut();
        let table = rt
            .guest(id)?
            .instance
            .get_table(&rt.store, a.str(1)?)
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        let id = rt.intern_table(table);
        rt.table_info(id)
    });
    let rt = runtime.clone();
    table.add("wasm.tableLength", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::table_length(id);
        }
        let rt = rt.borrow();
        Ok(Val::Num(rt.table(id)?.size(&rt.store) as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.tableGet", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::table_get(id, a.u32(1)?);
        }
        let mut rt = rt.borrow_mut();
        let value = rt
            .table(id)?
            .get(&rt.store, u64::from(a.u32(1)?))
            .ok_or_else(|| NativeError::range_error("WebAssembly table index out of bounds"))?;
        rt.js(&value)
    });
    let rt = runtime.clone();
    table.add("wasm.tableSet", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::table_set(id, a.u32(1)?, a.get(2));
        }
        let mut rt = rt.borrow_mut();
        let table = rt.table(id)?;
        let element = table.ty(&rt.store).element();
        let value = rt.wasm(a.get(2), element)?;
        table
            .set(&mut rt.store, u64::from(a.u32(1)?), value)
            .map_err(|error| NativeError::range_error(error.to_string()))?;
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.tableGrow", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::table_grow(id, a.u32(1)?, a.get(2));
        }
        let mut rt = rt.borrow_mut();
        let table = rt.table(id)?;
        let element = table.ty(&rt.store).element();
        let value = rt.wasm(a.get(2), element)?;
        let old = table
            .grow(&mut rt.store, u64::from(a.u32(1)?), value)
            .map_err(|error| NativeError::range_error(error.to_string()))?;
        Ok(Val::Num(old as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.memorySpan", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::span(id);
        }
        rt.borrow().memory_span(id)
    });
    let rt = runtime.clone();
    table.add("wasm.memoryIdentity", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::memory_identity(id);
        }
        let mut rt = rt.borrow_mut();
        let memory = rt.guest(id)?.memory(&rt.store, a.str(1)?)?;
        Ok(Val::Num(rt.intern_memory(memory) as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.growMemory", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::grow(id, a.u32(1)?);
        }
        let mut rt = rt.borrow_mut();
        let memory = rt.memory(id)?;
        let old = memory
            .grow(&mut rt.store, a.u32(1)? as u64)
            .map_err(error)?;
        Ok(Val::Num(old as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.createGlobal", move |a| {
        rt.borrow_mut()
            .create_global(a.str(0)?, a.bool(1), a.get(2))
    });
    let rt = runtime.clone();
    table.add("wasm.globalIdentity", move |a| {
        rt.borrow_mut().global_identity(a.u32(0)?, a.str(1)?)
    });
    let rt = runtime.clone();
    table.add("wasm.globalValue", move |a| {
        rt.borrow_mut()
            .global_value(a.get(0), (a.0.len() > 1).then(|| a.get(1)))
    });
    let rt = runtime.clone();
    table.add("wasm.globalImport", move |a| {
        rt.borrow_mut().scalar_global_import(a.get(0))
    });
    table.add("wasm.global", move |a| {
        let id = a.u32(0)?;
        #[cfg(bun_wasm_shared_group)]
        if nested::owns(id) {
            return nested::global(id, a.str(1)?, (a.0.len() > 2).then(|| a.get(2)));
        }
        let mut rt = runtime.borrow_mut();
        let global = rt
            .guest(id)?
            .instance
            .get_global(&rt.store, a.str(1)?)
            .ok_or_else(|| error("Missing WebAssembly global"))?;
        if a.0.len() > 2 {
            let content = global.ty(&rt.store).content();
            let value = rt.wasm(a.get(2), content)?;
            global.set(&mut rt.store, value).map_err(error)?;
        }
        let value = global.get(&rt.store);
        rt.js(&value)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replace_field(value: &Val, name: &str, replacement: Val) -> Val {
        let Val::Object(fields) = value else {
            panic!("global record");
        };
        Val::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if key == name {
                            replacement.clone()
                        } else {
                            value.clone()
                        },
                    )
                })
                .collect(),
        )
    }
    #[test]
    fn global_handles_validate_kind_backend_store_type_mutability_and_resource() {
        let mut runtime = Runtime::default();
        let info = runtime.create_global("i32", true, &Val::Num(7.0)).unwrap();
        for (key, value) in [
            ("kind", Val::from("table")),
            ("backend", Val::from("nested")),
            ("store", Val::Num(0.0)),
            ("id", Val::Num(-1.0)),
            ("id", Val::Num(0.5)),
            ("id", Val::Num(1.0)),
            ("type", Val::from("f32")),
            ("mutable", Val::Bool(false)),
        ] {
            assert!(
                runtime
                    .global_value(&replace_field(&info, key, value), None)
                    .is_err()
            );
        }
        let mut other = Runtime::default();
        other.create_global("i32", true, &Val::Num(7.0)).unwrap();
        assert!(other.global_value(&info, None).is_err());
        assert!(runtime.global_value(&tagged("global", 0), None).is_err());
        assert_eq!(runtime.globals.len(), 1);
    }
    #[test]
    fn globals_publish_only_after_validation_and_keep_constructor_origin_through_aliases() {
        let mut runtime = Runtime::default();
        for ty in ["externref", "funcref", "v128", "invalid"] {
            assert!(runtime.create_global(ty, false, &Val::Num(0.0)).is_err());
        }
        assert!(runtime.create_global("i64", false, &Val::Num(0.0)).is_err());
        assert!(runtime.globals.is_empty());
        let info = runtime.create_global("i32", false, &Val::Num(7.0)).unwrap();
        runtime
            .compile(include_bytes!(
                "../../../tests/fixtures/wasm-globals/immutable.wasm"
            ))
            .unwrap();
        runtime.instantiate(0, std::slice::from_ref(&info)).unwrap();
        let exported = runtime.global_identity(0, "g").unwrap();
        assert_eq!(exported, info);
        // Client metadata is not authority for constructor-origin admission.
        let fabricated_origin = replace_field(&exported, "origin", Val::from("export"));
        assert!(
            runtime
                .scalar_global_import(&fabricated_origin)
                .unwrap_err()
                .message
                .contains("Constructor-created")
        );
        let before = runtime.globals.len();
        assert!(runtime.instantiate(0, &[tagged("memory", 0)]).is_err());
        assert_eq!(runtime.guests.len(), 1);
        assert_eq!(runtime.globals.len(), before);
        assert!(
            runtime
                .global_value(&info, Some(&Val::from("invalid")))
                .unwrap_err()
                .message
                .contains("Immutable")
        );
    }
    #[test]
    fn exported_immutable_globals_keep_the_cross_backend_numeric_subset() {
        let mut runtime = Runtime::default();
        runtime
            .compile(include_bytes!(
                "../../../tests/fixtures/wasm-globals/provider.wasm"
            ))
            .unwrap();
        runtime.instantiate(0, &[]).unwrap();
        let immutable = runtime.global_identity(0, "immutable").unwrap();
        assert_eq!(
            runtime.scalar_global_import(&immutable).unwrap(),
            Val::Num(7.0)
        );
        let mutable = runtime.global_identity(0, "g").unwrap();
        assert!(runtime.scalar_global_import(&mutable).is_err());
        assert_eq!(runtime.global_identity(0, "alias").unwrap(), mutable);
        assert_ne!(runtime.global_identity(0, "equal").unwrap(), mutable);
    }
    #[test]
    fn failed_start_publishes_no_global_handles_but_keeps_imported_writes() {
        let mut runtime = Runtime::default();
        let info = runtime.create_global("i32", true, &Val::Num(0.0)).unwrap();
        runtime
            .compile(include_bytes!(
                "../../../tests/fixtures/wasm-globals/trap.wasm"
            ))
            .unwrap();
        assert!(runtime.instantiate(0, std::slice::from_ref(&info)).is_err());
        assert!(runtime.guests.is_empty());
        assert_eq!(runtime.globals.len(), 1);
        assert_eq!(runtime.global_value(&info, None).unwrap(), Val::Num(31.0));
    }

    const IMPORTED_MEMORY_MODULE: &[u8] = &[
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x09, 0x02, 0x60, 0x00, 0x01, 0x7f,
        0x60, 0x01, 0x7f, 0x00, 0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d,
        0x6f, 0x72, 0x79, 0x02, 0x01, 0x01, 0x02, 0x03, 0x03, 0x02, 0x00, 0x01, 0x07, 0x19, 0x03,
        0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x04, 0x73, 0x69, 0x7a, 0x65, 0x00,
        0x00, 0x05, 0x77, 0x72, 0x69, 0x74, 0x65, 0x00, 0x01, 0x0a, 0x13, 0x02, 0x07, 0x00, 0x41,
        0x00, 0x2d, 0x00, 0x00, 0x0b, 0x09, 0x00, 0x41, 0x00, 0x20, 0x00, 0x3a, 0x00, 0x00, 0x0b,
    ];

    fn memory_id(value: Val) -> u32 {
        let Val::Num(id) = value else {
            panic!("expected numeric memory id");
        };
        id as u32
    }

    #[test]
    fn engine_validates_eagerly_and_translates_lazily() {
        assert!(matches!(COMPILATION_MODE, CompilationMode::LazyTranslation));
    }

    #[test]
    fn standalone_memory_allocates_grows_and_enforces_maximum() {
        let mut runtime = Runtime::default();
        let id = memory_id(runtime.create_memory(1, Some(2)).unwrap());
        let memory = runtime.memory(id).unwrap();
        assert_eq!(memory.size(&runtime.store), 1);
        assert_eq!(memory.data(&runtime.store).len(), 65_536);

        assert_eq!(memory.grow(&mut runtime.store, 0).unwrap(), 1);
        assert_eq!(memory.growth_generation(&runtime.store), 1);
        assert_eq!(memory.grow(&mut runtime.store, 1).unwrap(), 1);
        assert_eq!(memory.size(&runtime.store), 2);
        assert!(memory.grow(&mut runtime.store, 1).is_err());
        assert_eq!(memory.size(&runtime.store), 2);
    }

    fn span(runtime: &Runtime, id: u32) -> (usize, usize, u64) {
        let Val::Object(fields) = runtime.memory_span(id).unwrap() else {
            panic!("expected memory span");
        };
        let field = |key: &str| {
            fields
                .iter()
                .find(|(name, _)| name == key)
                .unwrap()
                .1
                .clone()
        };
        let (Val::Num(pointer), Val::Num(length), Val::BigUint(generation)) =
            (field("pointer"), field("length"), field("generation"))
        else {
            panic!("malformed memory span");
        };
        (pointer as usize, length as usize, generation)
    }

    #[test]
    fn memory_span_tracks_the_store_bytes_through_growth() {
        let mut runtime = Runtime::default();
        let id = memory_id(runtime.create_memory(1, Some(3)).unwrap());
        let memory = runtime.memory(id).unwrap();
        let (pointer, length, generation) = span(&runtime, id);
        assert_eq!(pointer, memory.data(&runtime.store).as_ptr() as usize);
        assert_eq!((length, generation), (65_536, 0));
        memory.grow(&mut runtime.store, 0).unwrap();
        let (_, length, generation) = span(&runtime, id);
        assert_eq!((length, generation), (65_536, 1));
        memory.grow(&mut runtime.store, 2).unwrap();
        let (pointer, length, generation) = span(&runtime, id);
        assert_eq!(pointer, memory.data(&runtime.store).as_ptr() as usize);
        assert_eq!((length, generation), (3 * 65_536, 2));
        assert!(memory.grow(&mut runtime.store, 1).is_err());
        assert_eq!(span(&runtime, id).2, 2);
        assert!(runtime.memory_span(id + 1).is_err());
    }

    #[test]
    fn imported_memory_keeps_identity_and_wasm_writes_are_visible() {
        let mut runtime = Runtime::default();
        runtime
            .modules
            .push(Module::new(&runtime.engine, IMPORTED_MEMORY_MODULE).unwrap());
        let memory_resource = memory_id(runtime.create_memory(1, Some(2)).unwrap());
        let guest_id = memory_id(
            runtime
                .instantiate(0, &[Val::Num(memory_resource as f64)])
                .unwrap(),
        );
        let imported = runtime.guests[guest_id as usize]
            .memory(&runtime.store, "memory")
            .unwrap();
        assert_eq!(imported, runtime.memory(memory_resource).unwrap());

        call(&mut runtime, guest_id, "write", &[Val::Num(42.0)]).unwrap();
        assert_eq!(imported.data(&runtime.store)[0], 42);
    }
    #[test]
    fn imported_memory_checks_limits_and_aliases_across_instances() {
        let mut runtime = Runtime::default();
        runtime
            .modules
            .push(Module::new(&runtime.engine, IMPORTED_MEMORY_MODULE).unwrap());
        let resource = memory_id(runtime.create_memory(1, Some(2)).unwrap());
        runtime
            .instantiate(0, &[Val::Num(resource as f64)])
            .unwrap();
        runtime
            .instantiate(0, &[Val::Num(resource as f64)])
            .unwrap();
        let first = runtime.guests[0].memory(&runtime.store, "memory").unwrap();
        let second = runtime.guests[1].memory(&runtime.store, "memory").unwrap();
        assert_eq!(first, second);
        assert_eq!(runtime.intern_memory(second), resource);
        assert_eq!(runtime.memories.len(), 1);
        let small = runtime.create_memory(0, Some(2)).unwrap();
        let large = runtime.create_memory(1, Some(3)).unwrap();
        assert!(runtime.instantiate(0, &[small]).is_err());
        assert!(runtime.instantiate(0, &[large]).is_err());
        assert!(runtime.instantiate(0, &[Val::Num(-1.0)]).is_err());
        assert!(runtime.instantiate(0, &[Val::Num(0.5)]).is_err());
        assert!(runtime.instantiate(0, &[Val::Undefined]).is_err());
        assert!(runtime.create_memory(65_537, None).is_err());
        assert!(runtime.create_memory(2, Some(1)).is_err());
        assert_eq!(runtime.memories.len(), 3);
    }

    #[test]
    fn shared_store_preserves_resumable_calls_between_instances() {
        let mut runtime = Runtime::default();
        let bytes = include_bytes!("../../../tests/fixtures/webassembly/module.wasm");
        runtime
            .modules
            .push(Module::new(&runtime.engine, bytes).unwrap());
        runtime.instantiate(0, &[tagged("callback", 17)]).unwrap();
        runtime.instantiate(0, &[tagged("callback", 23)]).unwrap();
        let suspended = call(&mut runtime, 0, "invoke", &[Val::Num(5.0)]).unwrap();
        let Val::Object(suspended) = suspended else {
            panic!("expected suspended call");
        };
        assert!(
            suspended
                .iter()
                .any(|(key, value)| key == "import" && matches!(value, Val::Num(17.0)))
        );
        let result = call(&mut runtime, 1, "add", &[Val::Num(2.0), Val::Num(3.0)]).unwrap();
        assert_result(result, &[5.0]);
        assert_result(runtime.resume(0, &[Val::Num(7.0)]).unwrap(), &[8.0]);
        assert!(runtime.calls.is_empty());
        assert_result(call(&mut runtime, 1, "pair", &[]).unwrap(), &[7.0, 9.0]);
    }

    fn call(runtime: &mut Runtime, guest: u32, name: &str, args: &[Val]) -> NativeResult {
        let function = runtime
            .guest(guest)?
            .instance
            .get_func(&runtime.store, name)
            .unwrap();
        let id = runtime.intern_function(function);
        runtime.call(id, args)
    }

    fn assert_result(result: Val, expected: &[f64]) {
        let Val::Object(fields) = result else {
            panic!("expected call result");
        };
        let (_, Val::Array(values)) = &fields[0] else {
            panic!("expected result values");
        };
        let actual: Vec<_> = values
            .iter()
            .map(|value| match value {
                Val::Num(value) => *value,
                _ => panic!("expected numeric result"),
            })
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn dropping_runtime_drops_store_owned_resources() {
        let lifetime = std::sync::Arc::new(());
        let weak = std::sync::Arc::downgrade(&lifetime);
        let mut runtime = Runtime::default();
        runtime.create_memory(1, Some(2)).unwrap();
        runtime.store.limiter(move |_| {
            let _keep_alive = &lifetime;
            unreachable!("no allocation after installing drop observer")
        });
        assert!(weak.upgrade().is_some());
        drop(runtime);
        assert!(weak.upgrade().is_none());
    }
    fn fixture_runtime() -> Runtime {
        let bytes = include_bytes!("../../../tests/wasm-tables/table.wasm");
        let mut runtime = Runtime::default();
        runtime.compile(bytes).unwrap();
        runtime.instantiate(0, &[tagged("callback", 7)]).unwrap();
        runtime
    }
    #[test]
    fn public_reference_equality_is_store_and_entity_qualified() {
        let mut runtime = fixture_runtime();
        runtime.instantiate(0, &[tagged("callback", 8)]).unwrap();
        let first = runtime.guests[0].instance;
        let second = runtime.guests[1].instance;
        let other = fixture_runtime();
        let table = first.get_table(&runtime.store, "table").unwrap();
        assert_eq!(table, first.get_table(&runtime.store, "alias").unwrap());
        assert_ne!(table, second.get_table(&runtime.store, "table").unwrap());
        assert_ne!(
            table,
            other.guests[0]
                .instance
                .get_table(&other.store, "table")
                .unwrap()
        );
        let function = first.get_func(&runtime.store, "inc").unwrap();
        let WVal::FuncRef(element) = table.get(&runtime.store, 0).unwrap() else {
            panic!("function element")
        };
        assert_eq!(function, *element.func().unwrap());
        assert_ne!(function, second.get_func(&runtime.store, "inc").unwrap());
        assert_ne!(
            function,
            other.guests[0]
                .instance
                .get_func(&other.store, "inc")
                .unwrap()
        );
        assert_eq!(
            runtime.intern_function(function),
            runtime.intern_function(*element.func().unwrap())
        );
    }
    #[test]
    fn retained_function_and_externref_survive_guest_removal_and_drop_with_store() {
        let mut runtime = fixture_runtime();
        let table = runtime.guests[0]
            .instance
            .get_table(&runtime.store, "table")
            .unwrap();
        let WVal::FuncRef(function) = table.get(&runtime.store, 0).unwrap() else {
            panic!("function element")
        };
        let id = runtime.intern_function(*function.func().unwrap());
        runtime.guests.clear();
        assert_result(runtime.call(id, &[Val::Num(8.0)]).unwrap(), &[9.0]);
        let marker = std::sync::Arc::new(());
        let weak = std::sync::Arc::downgrade(&marker);
        let reference = ExternRef::new(&mut runtime.store, marker);
        let _table = WasmTable::new(
            &mut runtime.store,
            TableType::new(ValType::ExternRef, 1, None),
            WVal::ExternRef(reference),
        )
        .unwrap();
        assert!(weak.upgrade().is_some());
        drop(runtime);
        assert!(weak.upgrade().is_none());
    }
}
