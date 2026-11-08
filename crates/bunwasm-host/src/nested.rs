//! Native execution of the core's validated regionized modules, in the member Store.
use anyhow::{Context, Result, anyhow, bail, ensure};
use wasmtime::{
    Caller, Extern, Func, Global, GlobalType, Instance, Linker, Module, Mutability, Val, ValType,
};

use crate::{Host, shm};
use shm::nested::NestedMemory;
#[path = "../../bunwasm-runtime/src/wasm/nested_frame.rs"]
mod frame;
#[path = "../../bunwasm-runtime/src/wasm/nested_wire.rs"]
mod wire;
use wire::{BACKEND, Binding, MAX_RESOURCES, Number, Reply, Request};

#[derive(Default)]
pub(crate) struct State {
    modules: Vec<Module>,
    instances: Vec<Instance>,
    functions: Vec<Func>,
    function_keys: std::collections::HashMap<usize, u32>,
    memories: Vec<Option<NestedMemory>>,
    invocations: Vec<u32>,
    entries: Option<Entries>,
}

#[derive(Clone, Copy)]
struct Entries {
    alloc: Func,
    free: Func,
    dispatch: Func,
}

#[derive(Debug)]
struct PendingException;
impl std::fmt::Display for PendingException {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("pending engine-side exception")
    }
}
impl std::error::Error for PendingException {}

pub(crate) fn bind(core: Instance, store: &mut wasmtime::Store<Host>) -> Result<()> {
    let entries = Entries {
        alloc: core
            .get_func(&mut *store, "bun_core_alloc")
            .context("nested core allocator")?,
        free: core
            .get_func(&mut *store, "bun_core_free")
            .context("nested core free")?,
        dispatch: core
            .get_func(&mut *store, "bun_nested_dispatch")
            .context("nested core dispatcher")?,
    };
    store.data_mut().nested.entries = Some(entries);
    Ok(())
}

fn index(id: u32) -> Result<usize> {
    ensure!(id & BACKEND != 0, "mixed-backend WebAssembly resource");
    Ok((id & !BACKEND) as usize)
}
fn insert<T>(items: &mut Vec<T>, value: T) -> Result<u32> {
    ensure!(items.len() < MAX_RESOURCES, "nested resource limit");
    let id = items.len() as u32 | BACKEND;
    items.push(value);
    Ok(id)
}
fn memory(caller: &Caller<'_, Host>, id: u32) -> Result<NestedMemory> {
    caller
        .data()
        .nested
        .memories
        .get(index(id)?)
        .and_then(Clone::clone)
        .context("invalid nested memory")
}
fn guest_memory(caller: &Caller<'_, Host>) -> Result<crate::guest::GuestMemory> {
    caller
        .data()
        .memory
        .clone()
        .context("member shared memory is not bound")
}
fn read(caller: &Caller<'_, Host>, pointer: u32, length: u32) -> Result<Vec<u8>> {
    let end = pointer
        .checked_add(length)
        .context("nested span overflow")?;
    guest_memory(caller)?
        .read(caller, pointer as usize..end as usize)
        .context("nested span outside memory")
}
fn write(caller: &mut Caller<'_, Host>, pointer: u32, bytes: &[u8]) -> Result<()> {
    guest_memory(caller)?
        .write(&mut *caller, pointer as usize, bytes)
        .context("nested output outside memory")
}
fn allocate(caller: &mut Caller<'_, Host>, bytes: u32) -> Result<u32> {
    let entries = caller
        .data()
        .nested
        .entries
        .context("nested entries are not bound")?;
    let pointer = entries
        .alloc
        .typed::<(u32, u32), u32>(&*caller)?
        .call(&mut *caller, (bytes, 8))?;
    ensure!(pointer != 0, "nested transport allocation failed");
    Ok(pointer)
}
fn free(caller: &mut Caller<'_, Host>, pointer: u32, bytes: u32) -> Result<()> {
    let entries = caller
        .data()
        .nested
        .entries
        .context("nested entries are not bound")?;
    entries
        .free
        .typed::<(u32, u32, u32), ()>(&*caller)?
        .call(caller, (pointer, bytes, 8))
}

pub(crate) fn add_imports(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "runtime_nested",
        "request",
        |mut caller: Caller<'_, Host>, pointer: u32, length: u32, out: u32| -> Result<i32> {
            caller.data().cancel.check()?;
            ensure!(length <= 1 << 20, "nested request limit");
            let request: Request = serde_json::from_slice(&read(&caller, pointer, length)?)?;
            let category = if matches!(request, Request::Instantiate { .. }) {
                "LinkError"
            } else {
                "RuntimeError"
            };
            let reply = match execute(&mut caller, request) {
                Ok(reply) => reply,
                Err(error) => error_reply(error, category),
            };
            caller.data().cancel.check()?;
            let bytes = serde_json::to_vec(&reply)?;
            let length = u32::try_from(bytes.len())?;
            let pointer = allocate(&mut caller, length)?;
            if let Err(error) = write(&mut caller, pointer, &bytes) {
                free(&mut caller, pointer, length)?;
                return Err(error);
            }
            let mut header = [0; 8];
            header[..4].copy_from_slice(&pointer.to_le_bytes());
            header[4..].copy_from_slice(&length.to_le_bytes());
            write(&mut caller, out, &header)?;
            Ok(0)
        },
    )?;
    Ok(())
}

fn error_reply(error: anyhow::Error, category: &str) -> Reply {
    if error.downcast_ref::<PendingException>().is_some() {
        return Reply::PendingException;
    }
    let category = if error.downcast_ref::<wasmtime::Trap>().is_some() {
        "RuntimeError"
    } else {
        category
    };
    Reply::Error {
        category: category.to_owned(),
        message: format!("{error:#}"),
    }
}

fn execute(caller: &mut Caller<'_, Host>, request: Request) -> Result<Reply> {
    match request {
        Request::Reserve { initial, maximum } => {
            let member = caller
                .data()
                .shm
                .as_ref()
                .context("shared memory needs a group member")?;
            let region = NestedMemory::new(member, initial, maximum)
                .map_err(|error| anyhow!("region admission: {error:?}"))?;
            Ok(Reply::Handle(insert(
                &mut caller.data_mut().nested.memories,
                Some(region),
            )?))
        }
        Request::Span { memory: id } => {
            let region = memory(caller, id)?;
            Ok(Reply::Memory {
                pointer: region.base(),
                pages: region.pages(),
                maximum: region.maximum(),
                committed: u64::from(region.maximum().max(1)) * 65536,
            })
        }
        Request::Grow { memory: id, delta } => Ok(Reply::Count(
            memory(caller, id)?
                .grow(delta)
                .map_err(|error| anyhow!("memory growth: {error:?}"))?,
        )),
        Request::Release { memory: id } => {
            caller
                .data_mut()
                .nested
                .memories
                .get_mut(index(id)?)
                .context("invalid memory")?
                .take();
            Ok(Reply::Count(0))
        }
        Request::Compile { pointer, length } => {
            ensure!(
                caller.data().shm.is_some(),
                "nested execution requires shared-group"
            );
            let module = Module::new(caller.engine(), read(caller, pointer, length)?)?;
            Ok(Reply::Handle(insert(
                &mut caller.data_mut().nested.modules,
                module,
            )?))
        }
        Request::Instantiate {
            module,
            memory: id,
            bindings,
            invocation,
        } => enter(caller, invocation, |caller| {
            instantiate(caller, module, id, bindings)
        }),
        Request::Function { instance, name } => {
            let instance = *caller
                .data()
                .nested
                .instances
                .get(index(instance)?)
                .context("invalid instance")?;
            let function = instance
                .get_func(&mut *caller, &name)
                .context("missing nested function")?;
            function_info(caller, function)
        }
        Request::Call {
            function,
            arguments,
            invocation,
        } => enter(caller, invocation, |caller| {
            call(caller, function, arguments)
        }),
    }
}

fn enter(
    caller: &mut Caller<'_, Host>,
    invocation: u32,
    run: impl FnOnce(&mut Caller<'_, Host>) -> Result<Reply>,
) -> Result<Reply> {
    ensure!(
        invocation != 0 && caller.data().nested.invocations.len() < frame::MAX_DEPTH,
        "invalid nested invocation"
    );
    caller.data_mut().nested.invocations.push(invocation);
    let result = run(caller);
    assert_eq!(caller.data_mut().nested.invocations.pop(), Some(invocation));
    result
}

fn instantiate(
    caller: &mut Caller<'_, Host>,
    module: u32,
    id: u32,
    bindings: Vec<Binding>,
) -> Result<Reply> {
    let module = caller
        .data()
        .nested
        .modules
        .get(index(module)?)
        .context("invalid nested module")?
        .clone();
    let region = memory(caller, id)?;
    let mut imports = Vec::new();
    for import in module.imports() {
        imports.push(import_value(caller, &region, import, &bindings)?);
    }
    // No State, core Runtime, or region-owner mutex borrow survives this call.
    // Generated initialization and original start may synchronously enter guest JS.
    let instance = Instance::new(&mut *caller, &module, &imports)?;
    Ok(Reply::Handle(insert(
        &mut caller.data_mut().nested.instances,
        instance,
    )?))
}

fn import_value(
    caller: &mut Caller<'_, Host>,
    region: &NestedMemory,
    import: wasmtime::ImportType<'_>,
    bindings: &[Binding],
) -> Result<Extern> {
    if import.module() == "bunwasm_region" {
        return region_import(caller, region, import.name());
    }
    let binding = bindings
        .iter()
        .find(|binding| match binding {
            Binding::Callback { module, name, .. }
            | Binding::Function { module, name, .. }
            | Binding::Global { module, name, .. } => {
                module == import.module() && name == import.name()
            }
        })
        .context("missing nested import")?;
    match binding {
        Binding::Callback { id, .. } => {
            let ty = import
                .ty()
                .func()
                .cloned()
                .context("callback import type")?;
            ensure!(
                ty.params().len() <= frame::MAX_VALUES && ty.results().len() <= frame::MAX_VALUES,
                "callback value limit"
            );
            let results: Vec<_> = ty.results().collect();
            let id = *id;
            Ok(Func::new(&mut *caller, ty, move |mut caller, args, out| {
                dispatch(&mut caller, id, args, out, &results)
            })
            .into())
        }
        Binding::Function { id, .. } => Ok((*caller
            .data()
            .nested
            .functions
            .get(index(*id)?)
            .context("invalid nested function import")?)
        .into()),
        Binding::Global { value, .. } => {
            let value = number(*value);
            let ty = value.ty(&*caller)?;
            Ok(Global::new(&mut *caller, GlobalType::new(ty, Mutability::Const), value)?.into())
        }
    }
}

fn region_import(
    caller: &mut Caller<'_, Host>,
    region: &NestedMemory,
    name: &str,
) -> Result<Extern> {
    let r = region.clone();
    match name {
        "memory" => {
            let lease = caller
                .data()
                .shm
                .as_ref()
                .context("group member")?
                .group()
                .memory_lease();
            // SAFETY: this member Store and every nested instance retain the group's
            // outer backing lease until the Store is destroyed by settle().
            Ok(unsafe { lease.memory_for_admission() }.clone().into())
        }
        "base" => Ok(Global::new(
            &mut *caller,
            GlobalType::new(ValType::I32, Mutability::Const),
            Val::I32(r.base() as i32),
        )?
        .into()),
        "bound0" => Ok(Global::new(
            &mut *caller,
            GlobalType::new(ValType::I64, Mutability::Const),
            Val::I64(r.len() as i64),
        )?
        .into()),
        "length" => Ok(Func::wrap(&mut *caller, move || r.len() as i64).into()),
        "pages" => Ok(Func::wrap(&mut *caller, move || r.pages() as i32).into()),
        "grow" => Ok(Func::wrap(&mut *caller, move |delta: u32| {
            r.grow(delta).map_or(-1, |old| old as i32)
        })
        .into()),
        "wait32" => Ok(Func::wrap(
            &mut *caller,
            move |caller: Caller<'_, Host>,
                  addr: u32,
                  expected: i32,
                  timeout: i64|
                  -> Result<i32> {
                ensure!(r.contains(addr, 4), "nested wait32 outside region");
                let member = caller.data().shm.as_ref().context("group member")?;
                Ok(shm::futex_wait32(
                    member,
                    addr,
                    expected,
                    timeout,
                    &caller.data().cancel,
                ))
            },
        )
        .into()),
        "wait64" => Ok(Func::wrap(
            &mut *caller,
            move |caller: Caller<'_, Host>,
                  addr: u32,
                  expected: i64,
                  timeout: i64|
                  -> Result<i32> {
                ensure!(r.contains(addr, 8), "nested wait64 outside region");
                let member = caller.data().shm.as_ref().context("group member")?;
                Ok(shm::futex_wait64(
                    member,
                    addr,
                    expected,
                    timeout,
                    &caller.data().cancel,
                ))
            },
        )
        .into()),
        "notify" => Ok(Func::wrap(
            &mut *caller,
            move |caller: Caller<'_, Host>, addr: u32, count: u32| -> Result<i32> {
                ensure!(r.contains(addr, 4), "nested notify outside region");
                Ok(shm::futex_wake(
                    caller.data().shm.as_ref().context("group member")?,
                    addr,
                    count,
                ))
            },
        )
        .into()),
        _ => bail!("unknown region import"),
    }
}

fn function_info(caller: &mut Caller<'_, Host>, function: Func) -> Result<Reply> {
    let ty = function.ty(&*caller);
    let params = ty.params().map(type_name).collect::<Result<Vec<_>>>()?;
    let results = ty.results().map(type_name).collect::<Result<Vec<_>>>()?;
    let pointer = function.to_raw(&mut *caller) as usize;
    let existing = caller.data().nested.function_keys.get(&pointer).copied();
    let id = match existing {
        Some(id) => id,
        None => {
            let id = insert(&mut caller.data_mut().nested.functions, function)?;
            caller.data_mut().nested.function_keys.insert(pointer, id);
            id
        }
    };
    Ok(Reply::Function {
        id,
        params,
        results,
    })
}
fn type_name(ty: ValType) -> Result<String> {
    Ok(match ty {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        _ => bail!("reference/SIMD values cannot cross this nested JS ABI"),
    }
    .to_owned())
}
fn number(value: Number) -> Val {
    match value {
        Number::I32(n) => Val::I32(n),
        Number::I64(n) => Val::I64(n),
        Number::F32(n) => Val::F32(n),
        Number::F64(n) => Val::F64(n),
    }
}
fn numeric(value: &Val) -> Result<Number> {
    match value {
        Val::I32(n) => Ok(Number::I32(*n)),
        Val::I64(n) => Ok(Number::I64(*n)),
        Val::F32(n) => Ok(Number::F32(*n)),
        Val::F64(n) => Ok(Number::F64(*n)),
        _ => bail!("unsupported nested result value"),
    }
}
fn call(caller: &mut Caller<'_, Host>, id: u32, arguments: Vec<Number>) -> Result<Reply> {
    let function = *caller
        .data()
        .nested
        .functions
        .get(index(id)?)
        .context("invalid function")?;
    let args: Vec<_> = arguments.into_iter().map(number).collect();
    let mut results = function
        .ty(&*caller)
        .results()
        .map(|ty| Val::default_for_ty(&ty).context("result type"))
        .collect::<Result<Vec<_>>>()?;
    function.call(&mut *caller, &args, &mut results)?;
    Ok(Reply::Values(
        results.iter().map(numeric).collect::<Result<_>>()?,
    ))
}
fn slot(value: &Val) -> Result<frame::Slot> {
    let (kind, bits) = match numeric(value)? {
        Number::I32(n) => (0, n as u32 as u64),
        Number::I64(n) => (1, n as u64),
        Number::F32(n) => (2, u64::from(n)),
        Number::F64(n) => (3, n),
    };
    Ok(frame::Slot {
        kind,
        reserved: 0,
        bits,
    })
}
fn slot_value(value: frame::Slot, ty: &ValType) -> Result<Val> {
    ensure!(value.reserved == 0, "invalid callback slot");
    Ok(match (value.kind, ty) {
        (0, ValType::I32) => Val::I32(value.bits as i32),
        (1, ValType::I64) => Val::I64(value.bits as i64),
        (2, ValType::F32) => Val::F32(value.bits as u32),
        (3, ValType::F64) => Val::F64(value.bits),
        _ => bail!("callback result type mismatch"),
    })
}

fn dispatch(
    caller: &mut Caller<'_, Host>,
    callback: u32,
    args: &[Val],
    out: &mut [Val],
    types: &[ValType],
) -> Result<()> {
    let invocation = *caller
        .data()
        .nested
        .invocations
        .last()
        .context("callback outside invocation")?;
    ensure!(
        args.len() <= frame::MAX_VALUES && out.len() <= frame::MAX_VALUES,
        "callback value limit"
    );
    let mut frame = frame::CallbackFrame {
        arguments: args.len() as u32,
        results: out.len() as u32,
        ..Default::default()
    };
    for (target, value) in frame.slots.iter_mut().zip(args) {
        *target = slot(value)?;
    }
    let pointer = allocate(caller, frame::FRAME_BYTES)?;
    // SAFETY: CallbackFrame has only integer fields and no padding with this ABI.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            (&frame as *const frame::CallbackFrame).cast::<u8>(),
            frame::FRAME_BYTES as usize,
        )
    };
    write(caller, pointer, bytes)?;
    let result = dispatch_frame(caller, invocation, callback, pointer, out, types);
    free(caller, pointer, frame::FRAME_BYTES)?;
    result
}
fn dispatch_frame(
    caller: &mut Caller<'_, Host>,
    invocation: u32,
    callback: u32,
    pointer: u32,
    out: &mut [Val],
    types: &[ValType],
) -> Result<()> {
    let dispatch = caller
        .data()
        .nested
        .entries
        .context("nested entries")?
        .dispatch;
    let status = dispatch
        .typed::<(u32, u32, u32), u32>(&*caller)?
        .call(&mut *caller, (invocation, callback, pointer))?;
    if status == frame::PENDING_EXCEPTION {
        return Err(PendingException.into());
    }
    ensure!(status != frame::BAD_FRAME, "invalid engine callback frame");
    ensure!(status == frame::OK, "unknown engine callback status");
    let bytes = read(caller, pointer, frame::FRAME_BYTES)?;
    // SAFETY: the exact initialized wire length was checked; all bit patterns are valid.
    let frame = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<frame::CallbackFrame>()) };
    ensure!(frame.results as usize == out.len(), "callback result arity");
    for ((target, value), ty) in out.iter_mut().zip(frame.slots).zip(types) {
        *target = slot_value(value, ty)?;
    }
    Ok(())
}
