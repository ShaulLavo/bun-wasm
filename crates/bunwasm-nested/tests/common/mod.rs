#![allow(dead_code)]

use anyhow::{Result, anyhow, ensure};
use bunwasm_nested::{IMPORT_MODULE, MemoryPlan, regionize};
use wasmtime::{
    Caller, Config, Engine, Extern, Global, GlobalType, Instance, Linker, Memory, MemoryType,
    Module, Mutability, SharedMemory, Store, Val, ValType,
};

pub const PAGE: usize = 65536;
pub const BASE: usize = PAGE;
pub const SENTINEL: u8 = 0xa5;

#[derive(Clone)]
pub enum Backing {
    Plain(Memory),
    Shared(SharedMemory),
}

impl Backing {
    pub fn read(&self, store: &Store<State>) -> Vec<u8> {
        match self {
            Self::Plain(memory) => memory.data(store).to_vec(),
            // No guest is executing while the single-threaded harness reads or writes.
            Self::Shared(memory) => memory
                .data()
                .iter()
                .map(|byte| unsafe { *byte.get() })
                .collect(),
        }
    }

    fn write(&self, store: &mut Store<State>, offset: usize, data: &[u8]) -> Result<()> {
        match self {
            Self::Plain(memory) => memory.write(store, offset, data)?,
            Self::Shared(memory) => shared_write(memory, offset, data)?,
        }
        Ok(())
    }
}

fn shared_write(memory: &SharedMemory, offset: usize, data: &[u8]) -> Result<()> {
    let destination = memory
        .data()
        .get(offset..offset + data.len())
        .ok_or_else(|| anyhow!("test memory range"))?;
    for (byte, value) in destination.iter().zip(data) {
        unsafe {
            *byte.get() = *value;
        }
    }
    Ok(())
}

pub struct State {
    pub length: usize,
    pub maximum: usize,
    pub refreshes: usize,
    pub calls: Vec<(u32, u32, u64, i64)>,
    pub memory: Option<Backing>,
    pub shared: bool,
}

impl State {
    fn new(plan: Option<&MemoryPlan>) -> Self {
        Self {
            length: plan.map_or(0, |p| p.initial_pages as usize * PAGE),
            maximum: plan.map_or(0, |p| p.maximum_pages.unwrap_or(2).min(2) as usize * PAGE),
            refreshes: 0,
            calls: Vec::new(),
            memory: None,
            shared: plan.is_some_and(|p| p.shared),
        }
    }
}

pub struct Run {
    pub store: Store<State>,
    pub instance: Instance,
    pub memory: Option<Backing>,
    pub rewritten: bool,
}

pub fn engine() -> Engine {
    let mut config = Config::new();
    config
        .consume_fuel(true)
        .wasm_threads(true)
        .cranelift_nan_canonicalization(true);
    Engine::new(&config).unwrap()
}

impl Run {
    pub fn new(engine: &Engine, bytes: &[u8], rewritten: bool) -> Result<Self> {
        let compiled = regionize(bytes)?;
        let mut store = Store::new(engine, State::new(compiled.memory.as_ref()));
        store.set_fuel(10_000_000)?;
        let mut linker = Linker::new(engine);
        linker.func_wrap("env", "host", || 17i32)?;
        let offset = Global::new(
            &mut store,
            GlobalType::new(ValType::I32, Mutability::Const),
            Val::I32(3),
        )?;
        linker.define(&store, "env", "offset", offset)?;
        let memory = if rewritten {
            setup(&mut linker, &mut store, compiled.memory.as_ref())?
        } else {
            None
        };
        let module = Module::new(engine, if rewritten { &compiled.bytes } else { bytes })?;
        let instance = linker.instantiate(&mut store, &module)?;
        let memory = if rewritten {
            memory
        } else {
            exported_memory(&instance, &mut store)
        };
        Ok(Self {
            store,
            instance,
            memory,
            rewritten,
        })
    }

    pub fn call(&mut self, name: &str, params: &[Val]) -> Outcome {
        self.store.set_fuel(10_000_000).unwrap();
        let func = self.instance.get_func(&mut self.store, name).unwrap();
        let mut results: Vec<Val> = func
            .ty(&self.store)
            .results()
            .map(|ty| Val::default_for_ty(&ty).unwrap())
            .collect();
        match func.call(&mut self.store, params, &mut results) {
            Ok(()) => Outcome::Values(results.iter().map(value).collect()),
            Err(_) => Outcome::Trap,
        }
    }

    pub fn assert_sentinels(&self) {
        if !self.rewritten {
            return;
        }
        let Some(memory) = &self.memory else { return };
        let bytes = memory.read(&self.store);
        assert!(
            bytes[..BASE].iter().all(|byte| *byte == SENTINEL),
            "bytes below region"
        );
        assert!(
            bytes[BASE + self.store.data().length..]
                .iter()
                .all(|byte| *byte == SENTINEL),
            "bytes above region"
        );
    }

    pub fn region_bytes(&self) -> Vec<u8> {
        let Some(memory) = &self.memory else {
            return Vec::new();
        };
        let bytes = memory.read(&self.store);
        if self.rewritten {
            return bytes[BASE..BASE + self.store.data().length].to_vec();
        }
        bytes
    }
}

fn exported_memory(instance: &Instance, store: &mut Store<State>) -> Option<Backing> {
    for export in instance.exports(store) {
        match export.into_extern() {
            Extern::Memory(memory) => return Some(Backing::Plain(memory)),
            Extern::SharedMemory(memory) => return Some(Backing::Shared(memory)),
            _ => (),
        }
    }
    None
}

pub fn setup(
    linker: &mut Linker<State>,
    store: &mut Store<State>,
    plan: Option<&MemoryPlan>,
) -> Result<Option<Backing>> {
    let base = Global::new(
        &mut *store,
        GlobalType::new(ValType::I32, Mutability::Const),
        Val::I32(BASE as i32),
    )?;
    let length = store.data().length as i64;
    let bound = Global::new(
        &mut *store,
        GlobalType::new(ValType::I64, Mutability::Const),
        Val::I64(length),
    )?;
    linker.define(&*store, IMPORT_MODULE, "base", base)?;
    linker.define(&*store, IMPORT_MODULE, "bound0", bound)?;
    add_functions(linker)?;
    let Some(plan) = plan else { return Ok(None) };
    let memory = if plan.shared {
        let memory = SharedMemory::new(store.engine(), MemoryType::shared(4, 4))?;
        linker.define(&*store, IMPORT_MODULE, "memory", memory.clone())?;
        Backing::Shared(memory)
    } else {
        let memory = Memory::new(&mut *store, MemoryType::new(4, Some(4)))?;
        linker.define(&*store, IMPORT_MODULE, "memory", memory)?;
        Backing::Plain(memory)
    };
    memory.write(store, 0, &vec![SENTINEL; 4 * PAGE])?;
    memory.write(store, BASE, &vec![0; store.data().length])?;
    store.data_mut().memory = Some(memory.clone());
    Ok(Some(memory))
}

fn add_functions(linker: &mut Linker<State>) -> Result<()> {
    linker.func_wrap(IMPORT_MODULE, "length", |mut caller: Caller<'_, State>| {
        caller.data_mut().refreshes += 1;
        caller.data().length as i64
    })?;
    linker.func_wrap(IMPORT_MODULE, "pages", |caller: Caller<'_, State>| {
        (caller.data().length / PAGE) as i32
    })?;
    linker.func_wrap(IMPORT_MODULE, "grow", grow)?;
    linker.func_wrap(
        IMPORT_MODULE,
        "wait32",
        |caller: Caller<'_, State>, addr: u32, expected: u32, timeout: i64| {
            wait(caller, addr, u64::from(expected), timeout, 4)
        },
    )?;
    linker.func_wrap(
        IMPORT_MODULE,
        "wait64",
        |caller: Caller<'_, State>, addr: u32, expected: u64, timeout: i64| {
            wait(caller, addr, expected, timeout, 8)
        },
    )?;
    linker.func_wrap(
        IMPORT_MODULE,
        "notify",
        |mut caller: Caller<'_, State>, addr: u32, count: u32| {
            caller.data_mut().calls.push((0, addr, u64::from(count), 0));
            0i32
        },
    )?;
    Ok(())
}

fn grow(mut caller: Caller<'_, State>, delta: u32) -> Result<i32> {
    let old = caller.data().length;
    let next = old as u64 + u64::from(delta) * PAGE as u64;
    if next > caller.data().maximum as u64 {
        return Ok(-1);
    }
    let memory = caller.data().memory.clone().unwrap();
    let zeros = vec![0; next as usize - old];
    match memory {
        Backing::Plain(memory) => memory.write(&mut caller, BASE + old, &zeros)?,
        Backing::Shared(memory) => shared_write(&memory, BASE + old, &zeros)?,
    }
    caller.data_mut().length = next as usize;
    Ok((old / PAGE) as i32)
}

fn wait(
    mut caller: Caller<'_, State>,
    addr: u32,
    expected: u64,
    timeout: i64,
    width: usize,
) -> Result<i32> {
    ensure!(caller.data().shared, "wait on unshared memory");
    caller
        .data_mut()
        .calls
        .push((width as u32, addr, expected, timeout));
    let Backing::Shared(memory) = caller.data().memory.as_ref().unwrap() else {
        unreachable!()
    };
    let mut bytes = [0u8; 8];
    for (index, byte) in bytes[..width].iter_mut().enumerate() {
        *byte = unsafe { *memory.data()[addr as usize + index].get() };
    }
    if u64::from_le_bytes(bytes) != expected {
        return Ok(1);
    }
    ensure!(
        timeout == 0,
        "unbounded wait forbidden in differential harness"
    );
    Ok(2)
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Trap,
    Values(Vec<String>),
}

fn value(value: &Val) -> String {
    match value {
        Val::I32(x) => format!("i32:{x}"),
        Val::I64(x) => format!("i64:{x}"),
        Val::F32(x) if f32::from_bits(*x).is_nan() => "f32:nan".into(),
        Val::F64(x) if f64::from_bits(*x).is_nan() => "f64:nan".into(),
        Val::F32(x) => format!("f32:{x}"),
        Val::F64(x) => format!("f64:{x}"),
        Val::V128(x) => format!("v128:{}", x.as_u128()),
        other => format!("{other:?}"),
    }
}

pub struct Pair {
    pub native: Run,
    pub region: Run,
}

impl Pair {
    pub fn new(engine: &Engine, bytes: &[u8]) -> Result<Self> {
        Ok(Self {
            native: Run::new(engine, bytes, false)?,
            region: Run::new(engine, bytes, true)?,
        })
    }

    pub fn call(&mut self, name: &str, params: &[Val]) -> Outcome {
        let native = self.native.call(name, params);
        let region = self.region.call(name, params);
        assert_eq!(native, region, "function {name} params {params:?}");
        let native_bytes = self.native.region_bytes();
        let region_bytes = self.region.region_bytes();
        assert_eq!(
            native_bytes.len(),
            region_bytes.len(),
            "region length after {name}"
        );
        let mismatch = native_bytes
            .iter()
            .zip(&region_bytes)
            .position(|(a, b)| a != b);
        assert_eq!(mismatch, None, "region first mismatch after {name}");
        self.region.assert_sentinels();
        native
    }
}
