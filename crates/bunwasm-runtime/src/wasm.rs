use std::{cell::RefCell, collections::BTreeMap, fmt, rc::Rc};

use wasmi::{
    Engine, ExternType, Func, Instance, Linker, Memory, MemoryType, Module, ResumableCall,
    ResumableCallHostTrap, Store, Val as WVal,
    core::{HostError, ValType},
};

use crate::{
    engine::{NativeError, NativeResult, Record, Val},
    natives::Table,
};

#[derive(Debug)]
struct ImportCall {
    index: usize,
    args: Vec<WVal>,
}
impl fmt::Display for ImportCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "WebAssembly import {}", self.index)
    }
}
impl HostError for ImportCall {}

struct Suspended {
    invocation: ResumableCallHostTrap,
    outputs: Vec<WVal>,
}
struct Guest {
    instance: Instance,
    calls: BTreeMap<u32, Suspended>,
    next_call: u32,
}
struct Runtime {
    engine: Engine,
    store: Store<()>,
    modules: Vec<Module>,
    guests: Vec<Guest>,
    memories: Vec<Memory>,
}
impl Default for Runtime {
    fn default() -> Self {
        let engine = Engine::default();
        let store = Store::new(&engine, ());
        Self {
            engine,
            store,
            modules: Vec::new(),
            guests: Vec::new(),
            memories: Vec::new(),
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
fn numeric_type(ty: &ValType) -> Val {
    Val::Str(
        match ty {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
            _ => "reference",
        }
        .into(),
    )
}
fn describe(record: Record, ty: &ExternType) -> Record {
    let record = record.set("kind", kind(ty));
    match ty {
        ExternType::Func(ty) => record
            .set(
                "params",
                Val::Array(ty.params().iter().map(numeric_type).collect()),
            )
            .set(
                "results",
                Val::Array(ty.results().iter().map(numeric_type).collect()),
            ),
        ExternType::Global(ty) => record
            .set("type", numeric_type(&ty.content()))
            .set("mutable", ty.mutability().is_mut()),
        _ => record,
    }
}
fn js(value: &WVal) -> Result<Val, NativeError> {
    let value = match value {
        WVal::I32(n) => Val::Num(*n as f64),
        WVal::I64(n) => Val::BigInt(*n),
        WVal::F32(n) => Val::Num(f32::from(*n) as f64),
        WVal::F64(n) => Val::Num(f64::from(*n)),
        _ => {
            return Err(NativeError::type_error(
                "WebAssembly reference values are not supported by the interpreter adapter",
            ));
        }
    };
    Ok(value)
}

fn wasm(value: &Val, ty: ValType) -> Result<WVal, NativeError> {
    match (ty, value) {
        (ValType::I32, Val::Num(n)) => Ok(WVal::I32(*n as i32)),
        (ValType::I64, Val::BigInt(n)) => Ok(WVal::I64(*n)),
        (ValType::I64, Val::BigUint(n)) => Ok(WVal::I64(*n as i64)),
        (ValType::F32, Val::Num(n)) => Ok(WVal::F32((*n as f32).into())),
        (ValType::F64, Val::Num(n)) => Ok(WVal::F64((*n).into())),
        _ => Err(NativeError::type_error(
            "Invalid WebAssembly numeric argument",
        )),
    }
}
fn values(args: &[Val], types: &[ValType]) -> Result<Vec<WVal>, NativeError> {
    types
        .iter()
        .enumerate()
        .map(|(i, ty)| wasm(args.get(i).unwrap_or(&Val::Num(0.0)), *ty))
        .collect()
}
impl Guest {
    fn memory(&self, store: &Store<()>, name: &str) -> Result<Memory, NativeError> {
        self.instance
            .get_memory(store, name)
            .ok_or_else(|| error("Missing WebAssembly memory"))
    }
    fn finish(&mut self, result: ResumableCall, outputs: Vec<WVal>) -> NativeResult {
        let ResumableCall::HostTrap(invocation) = result else {
            if matches!(result, ResumableCall::OutOfFuel(_)) {
                return Err(error("WebAssembly fuel exhausted"));
            }
            return Ok(Record::new()
                .set(
                    "values",
                    Val::Array(outputs.iter().map(js).collect::<Result<_, _>>()?),
                )
                .into());
        };
        let import = invocation
            .host_error()
            .downcast_ref::<ImportCall>()
            .ok_or_else(|| error(invocation.host_error()))?;
        let id = self.next_call;
        self.next_call += 1;
        let response = Record::new()
            .set("call", id)
            .set("import", import.index as u32)
            .set(
                "args",
                Val::Array(import.args.iter().map(js).collect::<Result<_, _>>()?),
            );
        self.calls.insert(
            id,
            Suspended {
                invocation,
                outputs,
            },
        );
        Ok(response.into())
    }
    fn call(&mut self, store: &mut Store<()>, name: &str, args: &[Val]) -> NativeResult {
        let function = self
            .instance
            .get_func(&mut *store, name)
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        let ty = function.ty(&mut *store);
        let inputs = values(args, ty.params())?;
        let mut outputs: Vec<_> = ty.results().iter().copied().map(WVal::default).collect();
        let result = function
            .call_resumable(&mut *store, &inputs, &mut outputs)
            .map_err(error)?;
        self.finish(result, outputs)
    }
    fn resume(&mut self, store: &mut Store<()>, id: u32, args: &[Val]) -> NativeResult {
        let Suspended {
            invocation,
            mut outputs,
        } = self
            .calls
            .remove(&id)
            .ok_or_else(|| error("Invalid WebAssembly call"))?;
        let types = invocation.host_func().ty(&mut *store);
        let inputs = values(args, types.results())?;
        let result = invocation
            .resume(&mut *store, &inputs, &mut outputs)
            .map_err(error)?;
        self.finish(result, outputs)
    }
}
impl Runtime {
    fn guest(&self, id: u32) -> Result<&Guest, NativeError> {
        self.guests
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))
    }
    fn compile(&mut self, bytes: &[u8]) -> NativeResult {
        let module = Module::new(&self.engine, bytes).map_err(error)?;
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
            .map(|i| describe(Record::new().set("name", i.name()), i.ty()).into())
            .collect();
        let id = self.modules.len();
        self.modules.push(module);
        Ok(Record::new()
            .set("id", id as u32)
            .set("imports", imports)
            .set("exports", exports)
            .into())
    }
    fn memory_id(&self, value: &Val) -> Result<u32, NativeError> {
        let Val::Num(value) = value else {
            return Err(error("Expected a WebAssembly.Memory"));
        };
        if !value.is_finite() || *value < 0.0 || *value > u32::MAX as f64 || value.fract() != 0.0 {
            return Err(error("Invalid WebAssembly memory"));
        }
        let id = *value as u32;
        if self.memories.get(id as usize).is_none() {
            return Err(error("Invalid WebAssembly memory"));
        }
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
    fn create_memory(&mut self, minimum: u32, maximum: Option<u32>) -> NativeResult {
        let mut builder = MemoryType::builder();
        builder.min(u64::from(minimum));
        builder.max(maximum.map(u64::from));
        let ty = builder.build().map_err(error)?;
        let memory = Memory::new(&mut self.store, ty).map_err(error)?;
        Ok(Val::Num(self.intern_memory(memory) as f64))
    }
    fn instantiate(&mut self, id: u32, bindings: &[Val]) -> NativeResult {
        let module = self
            .modules
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly module"))?;
        let mut linker = Linker::new(&self.engine);
        for (index, import) in module.imports().enumerate() {
            let value: wasmi::Extern = match import.ty() {
                ExternType::Func(ty) => {
                    Func::new(&mut self.store, ty.clone(), move |_, args, _| {
                        Err(wasmi::Error::host(ImportCall {
                            index,
                            args: args.to_vec(),
                        }))
                    })
                    .into()
                }
                ExternType::Memory(_) => self
                    .memory(self.memory_id(bindings.get(index).unwrap_or(&Val::Undefined))?)?
                    .into(),
                _ => {
                    return Err(error(
                        "Only function and memory imports are supported by the WebAssembly interpreter",
                    ));
                }
            };
            linker
                .define(import.module(), import.name(), value)
                .map_err(error)?;
        }
        let instance = linker
            .instantiate(&mut self.store, module)
            .map_err(error)?
            .start(&mut self.store)
            .map_err(error)?;
        let memories: Vec<_> = instance
            .exports(&self.store)
            .filter_map(|export| export.into_memory())
            .collect();
        for memory in &memories {
            self.intern_memory(*memory);
        }
        let id = self.guests.len();
        self.guests.push(Guest {
            instance,
            calls: BTreeMap::new(),
            next_call: 0,
        });
        Ok(Val::Num(id as f64))
    }
}

pub fn install(table: &mut Table) {
    let runtime = Rc::new(RefCell::new(Runtime::default()));
    let rt = runtime.clone();
    table.add("wasm.validate", move |a| {
        Ok(Val::Bool(
            Module::new(&rt.borrow().engine, a.bytes(0)?).is_ok(),
        ))
    });
    let rt = runtime.clone();
    table.add("wasm.compile", move |a| {
        rt.borrow_mut().compile(a.bytes(0)?)
    });
    let rt = runtime.clone();
    table.add("wasm.instantiate", move |a| {
        rt.borrow_mut()
            .instantiate(a.u32(0)?, a.array(1).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.createMemory", move |a| {
        let mut rt = rt.borrow_mut();
        let maximum = if a.is_missing(1) {
            None
        } else {
            Some(a.u32(1)?)
        };
        rt.create_memory(a.u32(0)?, maximum)
    });
    let rt = runtime.clone();
    table.add("wasm.call", move |a| {
        let mut rt = rt.borrow_mut();
        let guest_id = a.u32(0)?;
        let name = a.str(1)?;
        let args = a.array(2).unwrap_or(&[]);
        let Runtime { store, guests, .. } = &mut *rt;
        let guest = guests
            .get_mut(guest_id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))?;
        guest.call(store, name, args)
    });
    let rt = runtime.clone();
    table.add("wasm.resume", move |a| {
        let mut rt = rt.borrow_mut();
        let guest_id = a.u32(0)?;
        let call_id = a.u32(1)?;
        let args = a.array(2).unwrap_or(&[]);
        let Runtime { store, guests, .. } = &mut *rt;
        let guest = guests
            .get_mut(guest_id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))?;
        guest.resume(store, call_id, args)
    });
    let rt = runtime.clone();
    table.add("wasm.cancel", move |a| {
        let mut rt = rt.borrow_mut();
        let guest_id = a.u32(0)?;
        let call_id = a.u32(1)?;
        rt.guests
            .get_mut(guest_id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))?
            .calls
            .remove(&call_id);
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.readMemory", move |a| {
        let rt = rt.borrow();
        let memory = rt.memory(a.u32(0)?)?;
        Ok(Record::new()
            .set("bytes", Val::Bytes(memory.data(&rt.store).to_vec()))
            .set(
                "generation",
                Val::BigUint(memory.growth_generation(&rt.store)),
            )
            .into())
    });
    let rt = runtime.clone();
    table.add("wasm.memoryIdentity", move |a| {
        let mut rt = rt.borrow_mut();
        let memory = {
            let guest = rt.guest(a.u32(0)?)?;
            guest.memory(&rt.store, a.str(1)?)?
        };
        Ok(Val::Num(rt.intern_memory(memory) as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.writeMemory", move |a| {
        let mut rt = rt.borrow_mut();
        let memory = rt.memory(a.u32(0)?)?;
        memory.write(&mut rt.store, 0, a.bytes(1)?).map_err(error)?;
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.growMemory", move |a| {
        let mut rt = rt.borrow_mut();
        let memory = rt.memory(a.u32(0)?)?;
        let old = memory
            .grow(&mut rt.store, a.u32(1)? as u64)
            .map_err(error)?;
        Ok(Val::Num(old as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.global", move |a| {
        let mut rt = rt.borrow_mut();
        let guest_id = a.u32(0)?;
        let name = a.str(1)?;
        let input = a.get(2);
        let Runtime { store, guests, .. } = &mut *rt;
        let guest = guests
            .get_mut(guest_id as usize)
            .ok_or_else(|| error("Invalid WebAssembly instance"))?;
        let global = guest
            .instance
            .get_global(&mut *store, name)
            .ok_or_else(|| error("Missing WebAssembly global"))?;
        if !matches!(input, Val::Undefined | Val::Null) {
            let value = wasm(input, global.ty(&mut *store).content())?;
            global.set(&mut *store, value).map_err(error)?;
        }
        js(&global.get(&mut *store))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let Runtime { store, guests, .. } = &mut runtime;
        guests[guest_id as usize]
            .call(store, "write", &[Val::Num(42.0)])
            .unwrap();
        assert_eq!(imported.data(store)[0], 42);
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
        runtime.instantiate(0, &[]).unwrap();
        runtime.instantiate(0, &[]).unwrap();
        let Runtime { store, guests, .. } = &mut runtime;
        let suspended = guests[0].call(store, "invoke", &[Val::Num(5.0)]).unwrap();
        let Val::Object(suspended) = suspended else {
            panic!("expected suspended call");
        };
        assert!(
            suspended
                .iter()
                .any(|(key, value)| key == "import" && matches!(value, Val::Num(0.0)))
        );
        let result = guests[1]
            .call(store, "add", &[Val::Num(2.0), Val::Num(3.0)])
            .unwrap();
        assert_result(result, &[5.0]);
        assert_result(
            guests[0].resume(store, 0, &[Val::Num(7.0)]).unwrap(),
            &[8.0],
        );
        assert!(guests[0].calls.is_empty());
        assert_result(guests[1].call(store, "pair", &[]).unwrap(), &[7.0, 9.0]);
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
}
