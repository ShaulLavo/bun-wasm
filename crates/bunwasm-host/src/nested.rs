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
    instances: Vec<Guest>,
    functions: Vec<Func>,
    function_keys: std::collections::HashMap<usize, u32>,
    memories: Resources<NestedMemory>,
    core_failed: bool,
    admission_error: Option<String>,
    invocations: Vec<u32>,
    entries: Option<Entries>,
    instantiation_attempts: u64,
    failed_instantiations: u64,
    refused_reservations: u64,
}

// Memory slots are reused, but identities never are. Retire a slot rather than wrap.
const SLOT_BITS: u32 = 12;
const MAX_GENERATION: u32 = (BACKEND - 1) >> SLOT_BITS;
struct Resource<T> {
    generation: u32,
    value: Option<T>,
}
struct Resources<T> {
    slots: Vec<Resource<T>>,
    free: Vec<usize>,
}
impl<T> Default for Resources<T> {
    fn default() -> Self {
        Self {
            slots: Vec::new(),
            free: Vec::new(),
        }
    }
}
impl<T> Resources<T> {
    fn insert(&mut self, value: T) -> Result<u32> {
        let slot = match self.free.pop() {
            Some(slot) => slot,
            None => {
                ensure!(self.slots.len() < MAX_RESOURCES, "nested resource limit");
                self.slots.push(Resource {
                    generation: 0,
                    value: None,
                });
                self.slots.len() - 1
            }
        };
        let entry = &mut self.slots[slot];
        entry.value = Some(value);
        Ok(BACKEND | (entry.generation << SLOT_BITS) | slot as u32)
    }
    fn slot(&self, id: u32) -> Result<usize> {
        let raw = index(id)?;
        let slot = raw & (MAX_RESOURCES - 1);
        let entry = self.slots.get(slot).context("invalid nested memory")?;
        ensure!(
            entry.generation == (raw >> SLOT_BITS) as u32 && entry.value.is_some(),
            "invalid nested memory"
        );
        Ok(slot)
    }
    fn get(&self, id: u32) -> Result<&T> {
        self.slots[self.slot(id)?]
            .value
            .as_ref()
            .context("invalid nested memory")
    }
    fn release(&mut self, id: u32) -> Result<()> {
        let slot = self.slot(id)?;
        let entry = &mut self.slots[slot];
        entry.value.take();
        if entry.generation == MAX_GENERATION {
            return Ok(());
        }
        entry.generation += 1;
        self.free.push(slot);
        Ok(())
    }
}

struct Guest {
    instance: Instance,
    _memory: NestedMemory,
}

impl State {
    pub(crate) fn snapshot(&self) -> serde_json::Value {
        let memories = self
            .memories
            .slots
            .iter()
            .filter_map(|slot| slot.value.as_ref());
        let committed: u64 = memories
            .clone()
            .map(|memory| u64::from(memory.maximum().max(1)) * 65536)
            .sum();
        let visible: u64 = memories.clone().map(NestedMemory::len).sum();
        serde_json::json!({ "modules": self.modules.len(), "instances": self.instances.len(),
            "functions": self.functions.len(), "memories": memories.count(),
            "reserved_committed_bytes": committed, "visible_bytes": visible,
            "memory_slots": self.memories.slots.len(), "core_failed": self.core_failed,
            "admission_closed": self.admission_error.is_some(), "active_invocations": self.invocations.len(), "instantiation_attempts": self.instantiation_attempts, "failed_instantiations": self.failed_instantiations, "refused_reservations": self.refused_reservations })
    }
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

#[derive(Debug)]
struct NestedExecution;
impl std::fmt::Display for NestedExecution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("nested execution failed")
    }
}
impl std::error::Error for NestedExecution {}

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
    caller.data().nested.memories.get(id).cloned()
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
    let result = entries
        .alloc
        .typed::<(u32, u32), u32>(&*caller)?
        .call(&mut *caller, (bytes, 8));
    let pointer = core_result(caller, result)?;
    ensure!(pointer != 0, "nested transport allocation failed");
    Ok(pointer)
}
fn free(caller: &mut Caller<'_, Host>, pointer: u32, bytes: u32) -> Result<()> {
    let entries = caller
        .data()
        .nested
        .entries
        .context("nested entries are not bound")?;
    let result = entries
        .free
        .typed::<(u32, u32, u32), ()>(&*caller)?
        .call(&mut *caller, (pointer, bytes, 8));
    core_result(caller, result)
}

#[derive(Debug)]
struct CoreFailure;
impl std::fmt::Display for CoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("reentered core failed")
    }
}
impl std::error::Error for CoreFailure {}

pub(crate) fn fatal_diagnostic(error: &anyhow::Error) -> Option<String> {
    error.downcast_ref::<CoreFailure>()?;
    Some(format!("reentered core failed: {}", error.root_cause()))
}
fn core_result<T>(caller: &mut Caller<'_, Host>, result: Result<T>) -> Result<T> {
    match result {
        Err(error) if !error.is::<PendingException>() => {
            caller.data_mut().nested.core_failed = true;
            Err(error.context(CoreFailure))
        }
        result => result,
    }
}

pub(crate) fn add_imports(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap(
        "runtime_nested",
        "request",
        |mut caller: Caller<'_, Host>, pointer: u32, length: u32, out: u32| -> Result<i32> {
            caller.data().cancel.check()?;
            ensure!(
                wire::request_length(length as usize).is_some(),
                "nested request limit"
            );
            let request: Request = serde_json::from_slice(&read(&caller, pointer, length)?)?;
            let category = if matches!(request, Request::Instantiate { .. }) {
                "LinkError"
            } else {
                "RuntimeError"
            };
            let reply = match execute(&mut caller, request) {
                Ok(reply) => reply,
                Err(error) if caller.data().nested.core_failed => return Err(error),
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
    let category = if error.downcast_ref::<wasmtime::Trap>().is_some()
        || error.downcast_ref::<NestedExecution>().is_some()
    {
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
            let region = match NestedMemory::new(member, initial, maximum) {
                Ok(region) => region,
                Err(error) => {
                    caller.data_mut().nested.refused_reservations += 1;
                    bail!("region admission: {error:?}");
                }
            };
            Ok(Reply::Handle(
                caller.data_mut().nested.memories.insert(region)?,
            ))
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
            caller.data_mut().nested.memories.release(id)?;
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
            let instance = caller
                .data()
                .nested
                .instances
                .get(index(instance)?)
                .context("invalid instance")?
                .instance;
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
        Request::PublishMemory { memory: id } => {
            let token = memory(caller, id)?
                .publish()
                .map_err(|error| anyhow!("shared memory publication: {error:?}"))?;
            Ok(Reply::Count(token))
        }
        Request::AttachMemory { token } => {
            let region = NestedMemory::attach(member(caller)?, token)
                .map_err(|error| anyhow!("shared memory attachment: {error:?}"))?;
            Ok(Reply::Handle(
                caller.data_mut().nested.memories.insert(region)?,
            ))
        }
        Request::PublishModule {
            module,
            description,
        } => {
            let compiled = caller
                .data()
                .nested
                .modules
                .get(index(module)?)
                .context("invalid nested module")?
                .clone();
            let token = shm::nested::publish_module(member(caller)?, compiled, description.into())
                .map_err(|error| anyhow!("shared module publication: {error:?}"))?;
            Ok(Reply::Count(token))
        }
        Request::AttachModule { token } => {
            let (module, description) = shm::nested::attach_module(member(caller)?, token)
                .map_err(|error| anyhow!("shared module attachment: {error:?}"))?;
            let id = insert(&mut caller.data_mut().nested.modules, module)?;
            Ok(Reply::AttachedModule {
                id,
                description: description.to_string(),
            })
        }
        Request::Withdraw { token } => {
            shm::nested::withdraw(member(caller)?, token)
                .map_err(|error| anyhow!("shared publication withdrawal: {error:?}"))?;
            Ok(Reply::Count(0))
        }
    }
}

fn member<'a>(caller: &'a Caller<'_, Host>) -> Result<&'a shm::MemberLease> {
    caller
        .data()
        .shm
        .as_ref()
        .context("shared object transport needs a group member")
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
    ensure!(
        caller.data().nested.instances.len() < MAX_RESOURCES,
        "nested instance limit"
    );
    if let Some(message) = &caller.data().nested.admission_error {
        bail!("{message}");
    }
    validate_bindings(caller, &module, &bindings)?;
    let mut imports = Vec::new();
    let mut bindings = bindings.iter();
    for import in module.imports() {
        let value = if import.module() == "bunwasm_region" {
            region_import(caller, &region, import.name())?
        } else {
            import_value(
                caller,
                import,
                bindings.next().context("missing nested import")?,
            )?
        };
        imports.push(value);
    }
    ensure!(bindings.next().is_none(), "extra nested binding");
    // No State, core Runtime, or region-owner mutex borrow survives this call.
    // Generated initialization and original start may synchronously enter guest JS.
    caller.data_mut().nested.instantiation_attempts = caller
        .data()
        .nested
        .instantiation_attempts
        .saturating_add(1);
    let instance = match Instance::new(&mut *caller, &module, &imports) {
        Ok(instance) => instance,
        Err(error) => {
            caller.data_mut().nested.failed_instantiations =
                caller.data().nested.failed_instantiations.saturating_add(1);
            // All import types were checked before allocating Store objects. Non-execution
            // failures close admission, so a saturated Store cannot retain more wrappers.
            if error.downcast_ref::<wasmtime::Trap>().is_none()
                && error.downcast_ref::<PendingException>().is_none()
                && error.downcast_ref::<NestedExecution>().is_none()
            {
                caller.data_mut().nested.admission_error = Some(format!("{error:#}"));
            }
            return Err(error);
        }
    };
    Ok(Reply::Handle(insert(
        &mut caller.data_mut().nested.instances,
        Guest {
            instance,
            _memory: region,
        },
    )?))
}

fn validate_bindings(
    caller: &Caller<'_, Host>,
    module: &Module,
    bindings: &[Binding],
) -> Result<()> {
    let imports = module
        .imports()
        .filter(|import| import.module() != "bunwasm_region");
    ensure!(
        module
            .imports()
            .filter(|import| import.module() != "bunwasm_region")
            .count()
            == bindings.len(),
        "nested import count"
    );
    for (import, binding) in imports.zip(bindings) {
        validate_binding(caller, import, binding)?;
    }
    Ok(())
}
fn validate_binding(
    caller: &Caller<'_, Host>,
    import: wasmtime::ImportType<'_>,
    binding: &Binding,
) -> Result<()> {
    let (module, name) = match binding {
        Binding::Callback { module, name, .. }
        | Binding::Function { module, name, .. }
        | Binding::Global { module, name, .. } => (module, name),
    };
    ensure!(
        module == import.module() && name == import.name(),
        "nested import order mismatch"
    );
    let expected = import.ty();
    match binding {
        Binding::Callback { .. } => {
            let ty = expected.func().context("callback import type")?;
            ensure!(
                ty.params().len() <= frame::MAX_VALUES && ty.results().len() <= frame::MAX_VALUES,
                "callback value limit"
            );
        }
        Binding::Function { id, .. } => {
            let function = caller
                .data()
                .nested
                .functions
                .get(index(*id)?)
                .context("invalid nested function import")?;
            let ty = expected.func().context("function import type")?;
            ensure!(
                function.ty(caller).matches(ty),
                "incompatible nested function import type"
            );
        }
        Binding::Global { value, .. } => {
            let ty = expected.global().context("global import type")?;
            ensure!(
                ty.mutability() == Mutability::Const
                    && ValType::eq(&number(*value).ty(caller)?, ty.content()),
                "incompatible nested global import type"
            );
        }
    }
    Ok(())
}

fn import_value(
    caller: &mut Caller<'_, Host>,
    import: wasmtime::ImportType<'_>,
    binding: &Binding,
) -> Result<Extern> {
    let (module, name) = match binding {
        Binding::Callback { module, name, .. }
        | Binding::Function { module, name, .. }
        | Binding::Global { module, name, .. } => (module, name),
    };
    ensure!(
        module == import.module() && name == import.name(),
        "nested import order mismatch"
    );
    match binding {
        Binding::Callback { id, .. } => callback_import(caller, import, *id),
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

fn callback_import(
    caller: &mut Caller<'_, Host>,
    import: wasmtime::ImportType<'_>,
    id: u32,
) -> Result<Extern> {
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
    Ok(Func::new(&mut *caller, ty, move |mut caller, args, out| {
        dispatch(&mut caller, id, args, out, &results).context(NestedExecution)
    })
    .into())
}

fn region_import(
    caller: &mut Caller<'_, Host>,
    region: &NestedMemory,
    name: &str,
) -> Result<Extern> {
    let weak = region.downgrade();
    match name {
        "memory" => {
            let lease = caller
                .data()
                .shm
                .as_ref()
                .context("group member")?
                .group()
                .memory_lease();
            // SAFETY: run_module_instance retains the backing until this Store dies.
            Ok(unsafe { lease.memory_for_admission() }.clone().into())
        }
        "base" => Ok(Global::new(
            &mut *caller,
            GlobalType::new(ValType::I32, Mutability::Const),
            Val::I32(region.base() as i32),
        )?
        .into()),
        "bound0" => Ok(Global::new(
            &mut *caller,
            GlobalType::new(ValType::I64, Mutability::Const),
            Val::I64(region.len() as i64),
        )?
        .into()),
        "length" => Ok(Func::wrap(&mut *caller, move || -> Result<i64> {
            upgrade(&weak)
                .map(|region| region.len() as i64)
                .context(NestedExecution)
        })
        .into()),
        "pages" => Ok(Func::wrap(&mut *caller, move || -> Result<i32> {
            upgrade(&weak)
                .map(|region| region.pages() as i32)
                .context(NestedExecution)
        })
        .into()),
        "grow" => Ok(Func::wrap(&mut *caller, move |delta: u32| -> Result<i32> {
            upgrade(&weak)
                .map(|region| region.grow(delta).map_or(-1, |old| old as i32))
                .context(NestedExecution)
        })
        .into()),
        "wait32" => Ok(wait32_import(caller, weak)),
        "wait64" => Ok(wait64_import(caller, weak)),
        "notify" => Ok(notify_import(caller, weak)),
        _ => bail!("unknown region import"),
    }
}
fn upgrade(weak: &shm::nested::WeakNestedMemory) -> Result<NestedMemory> {
    weak.upgrade()
        .map_err(|_| anyhow!("nested memory lease expired"))
}
fn wait32_import(caller: &mut Caller<'_, Host>, weak: shm::nested::WeakNestedMemory) -> Extern {
    Func::wrap(
        caller,
        move |caller: Caller<'_, Host>, addr: u32, expected: i32, timeout: i64| -> Result<i32> {
            (|| {
                let region = upgrade(&weak)?;
                ensure!(region.contains(addr, 4), "nested wait32 outside region");
                let member = caller.data().shm.as_ref().context("group member")?;
                let status =
                    shm::futex_wait32(member, addr, expected, timeout, &caller.data().cancel);
                caller.data().cancel.check()?;
                ensure!(status >= 0, "nested wait32 failed: {status}");
                Ok(status)
            })()
            .context(NestedExecution)
        },
    )
    .into()
}
fn wait64_import(caller: &mut Caller<'_, Host>, weak: shm::nested::WeakNestedMemory) -> Extern {
    Func::wrap(
        caller,
        move |caller: Caller<'_, Host>, addr: u32, expected: i64, timeout: i64| -> Result<i32> {
            (|| {
                let region = upgrade(&weak)?;
                ensure!(region.contains(addr, 8), "nested wait64 outside region");
                let member = caller.data().shm.as_ref().context("group member")?;
                let status =
                    shm::futex_wait64(member, addr, expected, timeout, &caller.data().cancel);
                caller.data().cancel.check()?;
                ensure!(status >= 0, "nested wait64 failed: {status}");
                Ok(status)
            })()
            .context(NestedExecution)
        },
    )
    .into()
}
fn notify_import(caller: &mut Caller<'_, Host>, weak: shm::nested::WeakNestedMemory) -> Extern {
    Func::wrap(
        caller,
        move |caller: Caller<'_, Host>, addr: u32, count: u32| -> Result<i32> {
            (|| {
                let region = upgrade(&weak)?;
                ensure!(region.contains(addr, 4), "nested notify outside region");
                Ok(shm::futex_wake(
                    caller.data().shm.as_ref().context("group member")?,
                    addr,
                    count,
                ))
            })()
            .context(NestedExecution)
        },
    )
    .into()
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
        ValType::V128 => "v128",
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
    if !caller.data().nested.core_failed {
        free(caller, pointer, frame::FRAME_BYTES)?;
    }
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
    let result = dispatch
        .typed::<(u32, u32, u32), u32>(&*caller)?
        .call(&mut *caller, (invocation, callback, pointer));
    let status = core_result(caller, result)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_callback_slots_preserve_bits_and_refuse_wrong_types() {
        let values = [
            Val::I32(-1),
            Val::I64(i64::MIN),
            Val::F32((-0.0f32).to_bits()),
            Val::F64(f64::NAN.to_bits()),
        ];
        let types = [ValType::I32, ValType::I64, ValType::F32, ValType::F64];
        for (value, ty) in values.iter().zip(types) {
            let encoded = slot(value).unwrap();
            let decoded = slot_value(encoded, &ty).unwrap();
            assert_eq!(format!("{value:?}"), format!("{decoded:?}"));
        }
        assert!(
            slot_value(
                frame::Slot {
                    kind: 1,
                    reserved: 0,
                    bits: 0
                },
                &ValType::I32
            )
            .is_err()
        );
        assert!(
            slot_value(
                frame::Slot {
                    kind: 0,
                    reserved: 1,
                    bits: 0
                },
                &ValType::I32
            )
            .is_err()
        );
        assert!(index(7).is_err());
        assert_eq!(index(BACKEND | 7).unwrap(), 7);
        assert_eq!(std::mem::size_of::<frame::CallbackFrame>(), 520);
    }

    #[test]
    fn resource_rejection_drops_an_unpublished_region() {
        let budget = shm::GroupBackingBudget::default();
        let group = shm::MemoryGroup::new(
            &wasmtime::Engine::default(),
            shm::GroupPolicy::default(),
            budget.clone(),
        )
        .unwrap();
        let member = group.reserve(702).unwrap().launch();
        let region = NestedMemory::new(&member, 1, 2).unwrap();
        let mut full = Resources::default();
        for _ in 0..MAX_RESOURCES {
            full.insert(region.clone()).unwrap();
        }
        assert!(full.insert(region).is_err());
        drop(full);
        assert_eq!(group.snapshot().regions, 0);
        member.physical_stopped();
        drop(group);
        assert_eq!(budget.committed_bytes(), 0);
    }
}

#[cfg(test)]
#[path = "nested_tests.rs"]
mod runtime_controls;
