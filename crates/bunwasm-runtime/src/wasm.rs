use std::{cell::RefCell, collections::BTreeMap, fmt, rc::Rc};

use wasmi::{
    Engine, ExternType, Func, Instance, Linker, Memory, Module, ResumableCall,
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
    store: Store<()>,
    instance: Instance,
    calls: BTreeMap<u32, Suspended>,
    next_call: u32,
    memories: Vec<Memory>,
}
#[derive(Default)]
struct Runtime {
    engine: Engine,
    modules: Vec<Module>,
    guests: Vec<Guest>,
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
    fn memory(&self, name: &str) -> Result<Memory, NativeError> {
        self.instance
            .get_memory(&self.store, name)
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
    fn call(&mut self, name: &str, args: &[Val]) -> NativeResult {
        let function = self
            .instance
            .get_func(&self.store, name)
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        let ty = function.ty(&self.store);
        let inputs = values(args, ty.params())?;
        let mut outputs: Vec<_> = ty.results().iter().copied().map(WVal::default).collect();
        let result = function
            .call_resumable(&mut self.store, &inputs, &mut outputs)
            .map_err(error)?;
        self.finish(result, outputs)
    }
    fn resume(&mut self, id: u32, args: &[Val]) -> NativeResult {
        let Suspended {
            invocation,
            mut outputs,
        } = self
            .calls
            .remove(&id)
            .ok_or_else(|| error("Invalid WebAssembly call"))?;
        let types = invocation.host_func().ty(&self.store);
        let inputs = values(args, types.results())?;
        let result = invocation
            .resume(&mut self.store, &inputs, &mut outputs)
            .map_err(error)?;
        self.finish(result, outputs)
    }
}
impl Runtime {
    fn guest(&mut self, id: u32) -> Result<&mut Guest, NativeError> {
        self.guests
            .get_mut(id as usize)
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
    fn instantiate(&mut self, id: u32) -> NativeResult {
        let module = self
            .modules
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly module"))?;
        let mut store = Store::new(&self.engine, ());
        let mut linker = Linker::new(&self.engine);
        for (index, import) in module.imports().enumerate() {
            let ExternType::Func(ty) = import.ty() else {
                return Err(error(
                    "Only function imports are supported by the WebAssembly interpreter",
                ));
            };
            let function = Func::new(&mut store, ty.clone(), move |_, args, _| {
                Err(wasmi::Error::host(ImportCall {
                    index,
                    args: args.to_vec(),
                }))
            });
            linker
                .define(import.module(), import.name(), function)
                .map_err(error)?;
        }
        let instance = linker
            .instantiate(&mut store, module)
            .map_err(error)?
            .start(&mut store)
            .map_err(error)?;
        let mut memories = Vec::new();
        for memory in instance
            .exports(&store)
            .filter_map(|export| export.into_memory())
        {
            if memories.contains(&memory) {
                continue;
            }
            memories.push(memory);
        }
        let id = self.guests.len();
        self.guests.push(Guest {
            store,
            instance,
            calls: BTreeMap::new(),
            next_call: 0,
            memories,
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
        rt.borrow_mut().instantiate(a.u32(0)?)
    });
    let rt = runtime.clone();
    table.add("wasm.call", move |a| {
        rt.borrow_mut()
            .guest(a.u32(0)?)?
            .call(a.str(1)?, a.array(2).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.resume", move |a| {
        rt.borrow_mut()
            .guest(a.u32(0)?)?
            .resume(a.u32(1)?, a.array(2).unwrap_or(&[]))
    });
    let rt = runtime.clone();
    table.add("wasm.cancel", move |a| {
        rt.borrow_mut().guest(a.u32(0)?)?.calls.remove(&a.u32(1)?);
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.read", move |a| {
        let mut rt = rt.borrow_mut();
        let guest = rt.guest(a.u32(0)?)?;
        let memory = guest.memory(a.str(1)?)?;
        Ok(Record::new()
            .set("bytes", Val::Bytes(memory.data(&guest.store).to_vec()))
            .set(
                "generation",
                Val::BigUint(memory.growth_generation(&guest.store)),
            )
            .into())
    });
    let rt = runtime.clone();
    table.add("wasm.memoryIdentity", move |a| {
        let mut rt = rt.borrow_mut();
        let guest = rt.guest(a.u32(0)?)?;
        let memory = guest.memory(a.str(1)?)?;
        Ok(Val::Num(
            guest.memories.iter().position(|m| *m == memory).unwrap() as f64,
        ))
    });
    let rt = runtime.clone();
    table.add("wasm.write", move |a| {
        let mut rt = rt.borrow_mut();
        let guest = rt.guest(a.u32(0)?)?;
        guest
            .memory(a.str(1)?)?
            .write(&mut guest.store, 0, a.bytes(2)?)
            .map_err(error)?;
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.grow", move |a| {
        let mut rt = rt.borrow_mut();
        let guest = rt.guest(a.u32(0)?)?;
        let old = guest
            .memory(a.str(1)?)?
            .grow(&mut guest.store, a.u32(2)? as u64)
            .map_err(error)?;
        Ok(Val::Num(old as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.global", move |a| {
        let mut rt = rt.borrow_mut();
        let guest = rt.guest(a.u32(0)?)?;
        let global = guest
            .instance
            .get_global(&guest.store, a.str(1)?)
            .ok_or_else(|| error("Missing WebAssembly global"))?;
        if !a.is_missing(2) {
            let value = wasm(a.get(2), global.ty(&guest.store).content())?;
            global.set(&mut guest.store, value).map_err(error)?;
        }
        js(&global.get(&guest.store))
    });
}
