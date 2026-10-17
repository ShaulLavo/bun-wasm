use std::{cell::RefCell, collections::BTreeMap, fmt, rc::Rc};

use wasmi::{
    Engine, ExternRef, ExternType, Func, FuncRef, Instance, Memory, Module, ResumableCall,
    ResumableCallHostTrap, Store, Table as WTable, TableType, Val as WVal,
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
    memories: Vec<Memory>,
}
struct Runtime {
    store: Store<()>,
    functions: Vec<Func>,
    references: BTreeMap<u32, ExternRef>,
    tables: Vec<WTable>,
    calls: BTreeMap<u32, Suspended>,
    next_call: u32,
    engine: Engine,
    modules: Vec<Module>,
    guests: Vec<Guest>,
}

impl Default for Runtime {
    fn default() -> Self {
        let engine = Engine::default();
        Self {
            store: Store::new(&engine, ()),
            engine,
            modules: Vec::new(),
            guests: Vec::new(),
            functions: Vec::new(),
            references: BTreeMap::new(),
            tables: Vec::new(),
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
fn numeric_type(ty: &ValType) -> Val {
    Val::Str(
        match ty {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
            ValType::FuncRef => "funcref",
            ValType::ExternRef => "externref",
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
        ExternType::Table(ty) => record.set("type", numeric_type(&ty.element())),
        _ => record,
    }
}
impl Runtime {
    fn function_id(&mut self, function: Func) -> u32 {
        let bits = u64::from(wasmi::core::UntypedVal::from(FuncRef::from(function)));
        if let Some(index) = self
            .functions
            .iter()
            .position(|f| u64::from(wasmi::core::UntypedVal::from(FuncRef::from(*f))) == bits)
        {
            return index as u32;
        }
        let id = self.functions.len() as u32;
        self.functions.push(function);
        id
    }
    fn table_id(&mut self, table: WTable) -> u32 {
        if let Some(index) = self.tables.iter().position(|t| *t == table) {
            return index as u32;
        }
        let id = self.tables.len() as u32;
        self.tables.push(table);
        id
    }
    fn js(&mut self, value: &WVal) -> Result<Val, NativeError> {
        Ok(match value {
            WVal::I32(n) => Val::Num(*n as f64),
            WVal::I64(n) => Val::BigInt(*n),
            WVal::F32(n) => Val::Num(f32::from(*n) as f64),
            WVal::F64(n) => Val::Num(f64::from(*n)),
            WVal::FuncRef(reference) => reference
                .func()
                .map(|f| Val::from(self.function_id(*f)))
                .unwrap_or(Val::Null),
            WVal::ExternRef(reference) => reference
                .data(&self.store)
                .and_then(|v| v.downcast_ref::<u32>())
                .map(|id| Val::from(*id))
                .unwrap_or(Val::Null),
            _ => {
                return Err(NativeError::type_error(
                    "Unsupported WebAssembly value type",
                ));
            }
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
            (ValType::FuncRef, Val::Num(id)) => self
                .functions
                .get(*id as usize)
                .copied()
                .map(WVal::from)
                .ok_or_else(|| error("Invalid function reference")),
            (ValType::ExternRef, Val::Null) => Ok(WVal::ExternRef(ExternRef::null())),
            (ValType::ExternRef, Val::Num(id)) => {
                let reference = self
                    .references
                    .entry(*id as u32)
                    .or_insert_with(|| ExternRef::new(&mut self.store, *id as u32));
                Ok(WVal::ExternRef(*reference))
            }
            _ => Err(NativeError::type_error("Invalid WebAssembly argument")),
        }
    }
    fn values(&mut self, args: &[Val], types: &[ValType]) -> Result<Vec<WVal>, NativeError> {
        types
            .iter()
            .enumerate()
            .map(|(i, ty)| self.wasm(args.get(i).unwrap_or(&Val::Undefined), *ty))
            .collect()
    }
    fn memory(&self, id: u32, name: &str) -> Result<Memory, NativeError> {
        self.guests
            .get(id as usize)
            .and_then(|guest| guest.instance.get_memory(&self.store, name))
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
                    Val::Array(
                        outputs
                            .iter()
                            .map(|v| self.js(v))
                            .collect::<Result<_, _>>()?,
                    ),
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
                Val::Array(
                    import
                        .args
                        .iter()
                        .map(|v| self.js(v))
                        .collect::<Result<_, _>>()?,
                ),
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
    fn call(&mut self, id: u32, args: &[Val]) -> NativeResult {
        let function = *self
            .functions
            .get(id as usize)
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        let ty = function.ty(&self.store);
        let inputs = self.values(args, ty.params())?;
        let mut outputs: Vec<_> = ty.results().iter().copied().map(WVal::default).collect();
        let result = match function.call_resumable(&mut self.store, &inputs, &mut outputs) {
            Ok(result) => result,
            Err(cause) => {
                let import = cause
                    .downcast_ref::<ImportCall>()
                    .ok_or_else(|| error(&cause))?;
                let args = import
                    .args
                    .iter()
                    .map(|value| self.js(value))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(Record::new()
                    .set("import", import.index as u32)
                    .set("args", args)
                    .set("direct", true)
                    .into());
            }
        };
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
        let inputs = self.values(args, types.results())?;
        let result = invocation
            .resume(&mut self.store, &inputs, &mut outputs)
            .map_err(error)?;
        self.finish(result, outputs)
    }
}
impl Runtime {
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
    fn instantiate(&mut self, id: u32, imports: &[Val]) -> NativeResult {
        let module = self
            .modules
            .get(id as usize)
            .ok_or_else(|| error("Invalid WebAssembly module"))?;
        let mut externals = Vec::with_capacity(imports.len());
        for (index, import) in module.imports().enumerate() {
            let value = imports.get(index).unwrap_or(&Val::Undefined);
            let external: wasmi::Extern = match import.ty() {
                ExternType::Table(_) => {
                    let Val::Num(id) = value else {
                        return Err(error("Expected WebAssembly table import"));
                    };
                    (*self
                        .tables
                        .get(*id as usize)
                        .ok_or_else(|| error("Invalid table import"))?)
                    .into()
                }
                ExternType::Func(ty) => {
                    let function = match value {
                        Val::Num(id) => *self
                            .functions
                            .get(*id as usize)
                            .ok_or_else(|| error("Invalid function import"))?,
                        Val::Array(callback) => {
                            let Some(Val::Num(id)) = callback.first() else {
                                return Err(error("Invalid callback import"));
                            };
                            let index = *id as usize;
                            Func::new(&mut self.store, ty.clone(), move |_, args, _| {
                                Err(wasmi::Error::host(ImportCall {
                                    index,
                                    args: args.to_vec(),
                                }))
                            })
                        }
                        _ => return Err(error("Expected WebAssembly function import")),
                    };
                    function.into()
                }
                _ => return Err(error("Unsupported WebAssembly import kind")),
            };
            externals.push(external);
        }
        let instance = module
            .instantiate(&mut self.store, externals)
            .map_err(error)?
            .start(&mut self.store)
            .map_err(error)?;
        let mut memories = Vec::new();
        for memory in instance
            .exports(&self.store)
            .filter_map(|export| export.into_memory())
        {
            if !memories.contains(&memory) {
                memories.push(memory);
            }
        }
        let id = self.guests.len();
        self.guests.push(Guest { instance, memories });
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
    table.add("wasm.function", move |a| {
        let mut rt = rt.borrow_mut();
        let function = rt
            .guests
            .get(a.u32(0)? as usize)
            .and_then(|g| g.instance.get_func(&rt.store, a.str(1).ok()?))
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        Ok(rt.function_id(function).into())
    });
    let rt = runtime.clone();
    table.add("wasm.functionType", move |a| {
        let rt = rt.borrow();
        let function = rt
            .functions
            .get(a.u32(0)? as usize)
            .ok_or_else(|| error("Missing WebAssembly function"))?;
        Ok(describe(Record::new(), &ExternType::Func(function.ty(&rt.store))).into())
    });
    let rt = runtime.clone();
    table.add("wasm.call", move |a| {
        rt.borrow_mut().call(a.u32(0)?, a.array(1).unwrap_or(&[]))
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
    table.add("wasm.read", move |a| {
        let rt = rt.borrow();
        let memory = rt.memory(a.u32(0)?, a.str(1)?)?;
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
        let rt = rt.borrow();
        let id = a.u32(0)?;
        let memory = rt.memory(id, a.str(1)?)?;
        Ok(Val::Num(
            rt.guests[id as usize]
                .memories
                .iter()
                .position(|m| *m == memory)
                .unwrap() as f64,
        ))
    });
    let rt = runtime.clone();
    table.add("wasm.write", move |a| {
        let mut rt = rt.borrow_mut();
        rt.memory(a.u32(0)?, a.str(1)?)?
            .write(&mut rt.store, 0, a.bytes(2)?)
            .map_err(error)?;
        Ok(Val::Undefined)
    });
    let rt = runtime.clone();
    table.add("wasm.grow", move |a| {
        let mut rt = rt.borrow_mut();
        let old = rt
            .memory(a.u32(0)?, a.str(1)?)?
            .grow(&mut rt.store, a.u32(2)? as u64)
            .map_err(error)?;
        Ok(Val::Num(old as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.global", move |a| {
        let mut rt = rt.borrow_mut();
        let global = rt
            .guests
            .get(a.u32(0)? as usize)
            .and_then(|g| g.instance.get_global(&rt.store, a.str(1).ok()?))
            .ok_or_else(|| error("Missing WebAssembly global"))?;
        if a.0.len() > 2 {
            let ty = global.ty(&rt.store).content();
            let value = rt.wasm(a.get(2), ty)?;
            global.set(&mut rt.store, value).map_err(error)?;
        }
        let value = global.get(&rt.store);
        rt.js(&value)
    });
    let rt = runtime.clone();
    table.add("wasm.table", move |a| {
        let mut rt = rt.borrow_mut();
        let table = rt
            .guests
            .get(a.u32(0)? as usize)
            .and_then(|g| g.instance.get_table(&rt.store, a.str(1).ok()?))
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        Ok(rt.table_id(table).into())
    });
    let rt = runtime.clone();
    table.add("wasm.tableNew", move |a| {
        let mut rt = rt.borrow_mut();
        let ty = if a.str(0)? == "funcref" {
            ValType::FuncRef
        } else {
            ValType::ExternRef
        };
        let value = rt.wasm(a.get(3), ty)?;
        let maximum = a.opt_num(2).map(|n| n as u32);
        let table = WTable::new(&mut rt.store, TableType::new(ty, a.u32(1)?, maximum), value)
            .map_err(error)?;
        Ok(rt.table_id(table).into())
    });
    let rt = runtime.clone();
    table.add("wasm.tableSize", move |a| {
        let rt = rt.borrow();
        let table = rt
            .tables
            .get(a.u32(0)? as usize)
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        Ok(Val::Num(table.size(&rt.store) as f64))
    });
    let rt = runtime.clone();
    table.add("wasm.tableGet", move |a| {
        let mut rt = rt.borrow_mut();
        let table = rt
            .tables
            .get(a.u32(0)? as usize)
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        let value = table
            .get(&rt.store, a.u32(1)? as u64)
            .ok_or_else(|| NativeError::range_error("Table index out of bounds"))?;
        rt.js(&value)
    });
    let rt = runtime.clone();
    table.add("wasm.tableSet", move |a| {
        let mut rt = rt.borrow_mut();
        let table = *rt
            .tables
            .get(a.u32(0)? as usize)
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        let ty = table.ty(&rt.store).element();
        let value = rt.wasm(a.get(2), ty)?;
        table
            .set(&mut rt.store, a.u32(1)? as u64, value)
            .map_err(|e| NativeError::range_error(e.to_string()))?;
        Ok(Val::Undefined)
    });
    table.add("wasm.tableGrow", move |a| {
        let mut rt = runtime.borrow_mut();
        let table = *rt
            .tables
            .get(a.u32(0)? as usize)
            .ok_or_else(|| error("Missing WebAssembly table"))?;
        let ty = table.ty(&rt.store).element();
        let value = rt.wasm(a.get(2), ty)?;
        let old = table
            .grow(&mut rt.store, a.u32(1)? as u64, value)
            .map_err(|e| NativeError::range_error(e.to_string()))?;
        Ok(Val::Num(old as f64))
    });
}
