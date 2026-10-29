//! Preview1 view of a memory-group member (docs/shared-group-profile.md).
//!
//! Wasmtime's preview1 finds guest memory through the calling instance's `memory` export
//! (wiggle: `caller.get_export("memory")`, `Extern::SharedMemory` becomes
//! `GuestMemory::Shared`). A group image may not export memory. One small adapter instance per
//! member imports the group memory, re-exports it as `memory`, and forwards each preview1
//! import the core uses through its own function, so preview1 sees the adapter as its caller.
//! This is the `process::wasi` delegate technique applied to a whole import set.

use anyhow::{Context, Result};
use wasm_encoder::{
    CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction, MemoryType, TypeSection, ValType as EncodedValue,
};
use wasmtime::{Engine, Extern, FuncType, Instance, Linker, Module, SharedMemory, Store, ValType};

const PREVIEW1: &str = "wasi_snapshot_preview1";

/// The forwarding adapter for every preview1 function `core` imports.
pub(super) struct Preview1View {
    module: Module,
    names: Vec<String>,
}

impl Preview1View {
    /// One view for every preview1 function the member's images (core and side) import.
    pub(super) fn new(engine: &Engine, images: &[&Module], maximum_pages: u64) -> Result<Self> {
        let mut functions: Vec<(String, FuncType)> = Vec::new();
        for image in images {
            for import in image.imports().filter(|import| import.module() == PREVIEW1) {
                let ty = import
                    .ty()
                    .func()
                    .context("preview1 import is not a function")?
                    .clone();
                let name = import.name();
                if !functions.iter().any(|(known, _)| known == name) {
                    functions.push((name.to_owned(), ty));
                }
            }
        }
        let bytes = adapter(&functions, maximum_pages)?;
        let names = functions.into_iter().map(|(name, _)| name).collect();
        Ok(Self {
            module: Module::new(engine, bytes)?,
            names,
        })
    }

    /// Instantiate the view over `memory` and define the core's preview1 imports from it in
    /// `linker`, shadowing the host's direct definitions for this member only.
    pub(super) fn bind<T>(
        &self,
        store: &mut Store<T>,
        linker: &mut Linker<T>,
        memory: &SharedMemory,
    ) -> Result<Instance> {
        let mut forwarding = Linker::new(store.engine());
        forwarding.define(&*store, "t", "memory", memory.clone())?;
        for name in &self.names {
            let original = linker
                .get(&mut *store, PREVIEW1, name)
                .with_context(|| format!("missing {PREVIEW1}.{name}"))?;
            forwarding.define(&*store, "t", name, original)?;
        }
        let view = forwarding.instantiate(&mut *store, &self.module)?;
        linker.allow_shadowing(true);
        for name in &self.names {
            let function = view.get_func(&mut *store, name).context("view export")?;
            linker.define(&*store, PREVIEW1, name, Extern::Func(function))?;
        }
        linker.allow_shadowing(false);
        Ok(view)
    }
}

fn value(ty: ValType) -> Result<EncodedValue> {
    Ok(match ty {
        ValType::I32 => EncodedValue::I32,
        ValType::I64 => EncodedValue::I64,
        ValType::F32 => EncodedValue::F32,
        ValType::F64 => EncodedValue::F64,
        other => anyhow::bail!("unsupported preview1 value type {other}"),
    })
}

/// `t.<name>` imports and `t.memory`; one forwarding function and export per name.
fn adapter(functions: &[(String, FuncType)], maximum_pages: u64) -> Result<Vec<u8>> {
    let mut types = TypeSection::new();
    let mut imports = ImportSection::new();
    let mut defined = FunctionSection::new();
    let mut exports = ExportSection::new();
    let mut code = CodeSection::new();
    let count = functions.len() as u32;
    for (index, (name, ty)) in functions.iter().enumerate() {
        let index = index as u32;
        let params = ty.params().map(value).collect::<Result<Vec<_>>>()?;
        let results = ty.results().map(value).collect::<Result<Vec<_>>>()?;
        types.ty().function(params.iter().copied(), results);
        imports.import("t", name, EntityType::Function(index));
        defined.function(index);
        exports.export(name, ExportKind::Func, count + index);
        let mut body = Function::new([]);
        for local in 0..params.len() as u32 {
            body.instruction(&Instruction::LocalGet(local));
        }
        body.instruction(&Instruction::Call(index));
        body.instruction(&Instruction::End);
        code.function(&body);
    }
    let memory = MemoryType {
        minimum: 1,
        maximum: Some(maximum_pages),
        memory64: false,
        shared: true,
        page_size_log2: None,
    };
    imports.import("t", "memory", memory);
    exports.export("memory", ExportKind::Memory, 0);
    let mut module = wasm_encoder::Module::new();
    module
        .section(&types)
        .section(&imports)
        .section(&defined)
        .section(&exports)
        .section(&code);
    Ok(module.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_encoder::{ConstExpr, DataSection, MemArg};
    use wasmtime::{Config, MemoryType as HostMemory};
    use wasmtime_wasi::WasiCtxBuilder;
    use wasmtime_wasi::p1::{self, WasiP1Ctx};
    use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};

    const MAX: u32 = 8192;

    fn store_i32(at: u32, value: i32) -> [Instruction<'static>; 3] {
        [
            Instruction::I32Const(at as i32),
            Instruction::I32Const(value),
            Instruction::I32Store(MemArg {
                offset: 0,
                align: 2,
                memory_index: 0,
            }),
        ]
    }

    /// A member-shaped module: imports the shared group memory and three preview1 functions,
    /// never exports memory. `run` writes "hello", reads stdin into 3000 and asks for argv sizes.
    fn member() -> Vec<u8> {
        let mut types = TypeSection::new();
        let io = [EncodedValue::I32; 4];
        types.ty().function(io, [EncodedValue::I32]);
        types
            .ty()
            .function([EncodedValue::I32; 2], [EncodedValue::I32]);
        types.ty().function([], []);
        let mut imports = ImportSection::new();
        let memory = MemoryType {
            minimum: 1,
            maximum: Some(u64::from(MAX)),
            memory64: false,
            shared: true,
            page_size_log2: None,
        };
        imports.import("env", "memory", memory);
        imports.import(PREVIEW1, "fd_write", EntityType::Function(0));
        imports.import(PREVIEW1, "fd_read", EntityType::Function(0));
        imports.import(PREVIEW1, "args_sizes_get", EntityType::Function(1));
        let mut functions = FunctionSection::new();
        functions.function(2);
        let mut exports = ExportSection::new();
        exports.export("run", ExportKind::Func, 3);
        let mut body = Function::new([]);
        let calls: [(u32, [i32; 4]); 2] = [(0, [1, 2048, 1, 2100]), (1, [0, 2200, 1, 2300])];
        for instruction in store_i32(2048, 1024)
            .into_iter()
            .chain(store_i32(2052, 5))
            .chain(store_i32(2200, 3000))
            .chain(store_i32(2204, 16))
        {
            body.instruction(&instruction);
        }
        for (function, args) in calls {
            for arg in args {
                body.instruction(&Instruction::I32Const(arg));
            }
            body.instruction(&Instruction::Call(function));
            body.instruction(&Instruction::Drop);
        }
        body.instruction(&Instruction::I32Const(2400));
        body.instruction(&Instruction::I32Const(2404));
        body.instruction(&Instruction::Call(2));
        body.instruction(&Instruction::Drop);
        body.instruction(&Instruction::End);
        let mut code = CodeSection::new();
        code.function(&body);
        let mut data = DataSection::new();
        data.active(0, &ConstExpr::i32_const(1024), b"hello".iter().copied());
        let mut module = wasm_encoder::Module::new();
        module
            .section(&types)
            .section(&imports)
            .section(&functions)
            .section(&exports)
            .section(&code)
            .section(&data);
        module.finish()
    }

    fn word(memory: &SharedMemory, at: usize) -> u32 {
        let cells = &memory.data()[at..at + 4];
        let bytes: Vec<u8> = cells.iter().map(|cell| unsafe { *cell.get() }).collect();
        u32::from_le_bytes(bytes.try_into().unwrap())
    }

    #[test]
    fn preview1_reads_and_writes_a_shared_member_memory_through_the_view() {
        let mut config = Config::new();
        config.wasm_threads(true);
        let engine = Engine::new(&config).unwrap();
        let stdout = MemoryOutputPipe::new(64);
        let wasi = WasiCtxBuilder::new()
            .stdin(MemoryInputPipe::new("stdin bytes"))
            .stdout(stdout.clone())
            .args(&["bun", "-e", "1"])
            .build_p1();
        let mut store: Store<WasiP1Ctx> = Store::new(&engine, wasi);
        let mut linker = Linker::new(&engine);
        p1::add_to_linker_sync(&mut linker, |cx| cx).unwrap();
        let memory = SharedMemory::new(&engine, HostMemory::shared(1, MAX)).unwrap();
        let module = Module::new(&engine, member()).unwrap();
        assert!(
            module
                .exports()
                .all(|export| export.ty().memory().is_none())
        );
        let view = Preview1View::new(&engine, &[&module], u64::from(MAX)).unwrap();
        view.bind(&mut store, &mut linker, &memory).unwrap();
        linker
            .define(&store, "env", "memory", memory.clone())
            .unwrap();
        let instance = linker.instantiate(&mut store, &module).unwrap();
        instance
            .get_typed_func::<(), ()>(&mut store, "run")
            .unwrap()
            .call(&mut store, ())
            .unwrap();
        assert_eq!(&stdout.contents()[..], b"hello");
        assert_eq!(word(&memory, 2100), 5);
        assert_eq!(word(&memory, 2300), 11);
        let read: Vec<u8> = memory.data()[3000..3011]
            .iter()
            .map(|cell| unsafe { *cell.get() })
            .collect();
        assert_eq!(read, b"stdin bytes");
        assert_eq!(word(&memory, 2400), 3);
    }

    #[test]
    fn without_the_view_preview1_refuses_a_member_that_exports_no_memory() {
        let mut config = Config::new();
        config.wasm_threads(true);
        let engine = Engine::new(&config).unwrap();
        let mut store: Store<WasiP1Ctx> = Store::new(&engine, WasiCtxBuilder::new().build_p1());
        let mut linker = Linker::new(&engine);
        p1::add_to_linker_sync(&mut linker, |cx| cx).unwrap();
        let memory = SharedMemory::new(&engine, HostMemory::shared(1, MAX)).unwrap();
        linker.define(&store, "env", "memory", memory).unwrap();
        let module = Module::new(&engine, member()).unwrap();
        let instance = linker.instantiate(&mut store, &module).unwrap();
        let run = instance
            .get_typed_func::<(), ()>(&mut store, "run")
            .unwrap();
        let error = run.call(&mut store, ()).unwrap_err();
        assert!(format!("{error:#}").contains("missing required memory export"));
    }
}
