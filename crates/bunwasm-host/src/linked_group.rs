//! Shared-group program admission and member linking (docs/shared-group-profile.md).
//!
//! A shared-group core is a PIE image (`dylink.0`) that imports one shared memory, its own table,
//! its bases and a mutable stack pointer. Its side imports the same shared memory. Admission
//! mirrors Waffle's group loader: no image may grow or export the group memory, because the
//! group's owner charges every byte through `runtime_shm.group_grow`. There is no bypass.

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{
    Dylink0Subsection, ExternalKind, KnownCustom, MemInfo, Operator, Parser, Payload, TypeRef,
};
use wasmtime::{
    Extern, Global, GlobalType, Instance, Linker, Module, Mutability, Ref, RefType, SharedMemory,
    Store, Table, TableType, Val, ValType,
};

/// Bun's wasm32 string tags use address bits 29-31, so a Bun group stays below 512 MiB.
pub(super) const MAX_PAGES: u64 = 8192;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
/// The Bun parser's stack. A PIE member's stack is carved by its host.
pub(super) const STACK_BYTES: u32 = 8 << 20;
const PAGE: u32 = 65_536;
/// Explicit initialization order of a shared-group core.
pub(super) const CORE_INITIALIZE: [&str; 3] = [
    "core_initialize_memory",
    "__wasm_apply_data_relocs",
    "__wasm_call_ctors",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Profile {
    Split,
    SharedGroup,
}

/// What admission needs to know about one image, read without decoding function bodies.
#[derive(Default)]
struct Summary {
    dylink: bool,
    needed: bool,
    start: bool,
    memory_export: bool,
    /// `(shared, maximum)` of the `env.memory` import.
    memory: Option<(bool, Option<u64>)>,
    functions: Vec<String>,
}

/// Classify one image and admit it if it is a group image. A core is a group image when it is
/// relocatable; a side is one when it imports a shared memory.
pub(super) fn admit(bytes: &[u8], core: bool) -> Result<Profile> {
    let summary = summarize(bytes)?;
    let group = if core {
        summary.dylink
    } else {
        summary.memory.is_some_and(|(shared, _)| shared)
    };
    if !group {
        return Ok(Profile::Split);
    }
    let what = if core { "core" } else { "side" };
    ensure!(
        !summary.needed,
        "memory group {what} must not need a shared library"
    );
    ensure!(
        !summary.start,
        "memory group {what} must use explicit initialization"
    );
    ensure!(
        !summary.memory_export,
        "a memory group image cannot export the shared memory"
    );
    if core {
        admit_core(&summary)?;
    }
    ensure!(
        growth_free(bytes)?,
        "a memory group image cannot use memory.grow; grow through group_grow"
    );
    Ok(Profile::SharedGroup)
}

fn admit_core(summary: &Summary) -> Result<()> {
    let Some((shared, maximum)) = summary.memory else {
        bail!("memory group core must import env.memory");
    };
    ensure!(shared, "memory group core must import a shared memory");
    ensure!(
        maximum == Some(MAX_PAGES),
        "memory group core must declare a {MAX_PAGES}-page maximum"
    );
    for name in CORE_INITIALIZE.into_iter().chain(["_start"]) {
        ensure!(
            summary.functions.iter().any(|export| export == name),
            "memory group core is missing {name}"
        );
    }
    Ok(())
}

fn summarize(bytes: &[u8]) -> Result<Summary> {
    let mut summary = Summary::default();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::StartSection { .. } => summary.start = true,
            Payload::ImportSection(imports) => {
                for import in imports {
                    read_import(import?, &mut summary);
                }
            }
            Payload::ExportSection(exports) => {
                for export in exports {
                    read_export(export?, &mut summary);
                }
            }
            Payload::CustomSection(section) => read_dylink(section.as_known(), &mut summary)?,
            _ => {}
        }
    }
    Ok(summary)
}

fn read_import(import: wasmparser::Import<'_>, summary: &mut Summary) {
    if let TypeRef::Memory(memory) = import.ty
        && (import.module, import.name) == ("env", "memory")
    {
        summary.memory = Some((memory.shared, memory.maximum));
    }
}

fn read_export(export: wasmparser::Export<'_>, summary: &mut Summary) {
    match export.kind {
        ExternalKind::Memory => summary.memory_export = true,
        ExternalKind::Func => summary.functions.push(export.name.to_owned()),
        _ => {}
    }
}

fn read_dylink(section: KnownCustom<'_>, summary: &mut Summary) -> Result<()> {
    let KnownCustom::Dylink0(subsections) = section else {
        return Ok(());
    };
    summary.dylink = true;
    for subsection in subsections {
        if let Dylink0Subsection::Needed(names) = subsection? {
            summary.needed |= !names.is_empty();
        }
    }
    Ok(())
}

/// True when no function body contains `memory.grow`. An undecodable body is an error.
fn growth_free(bytes: &[u8]) -> Result<bool> {
    for payload in Parser::new(0).parse_all(bytes) {
        let Payload::CodeSectionEntry(body) = payload? else {
            continue;
        };
        let mut operators = body.get_operators_reader()?;
        while !operators.eof() {
            if matches!(operators.read()?, Operator::MemoryGrow { .. }) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
/// Where a group host carves a member's private chunks. Waffle's owner and the wasmtime group
/// service implement it with `group_grow` accounting; chunks are zeroed and never overlap.
pub(super) trait Placement {
    /// The first page index of a fresh chunk of `pages` pages.
    fn carve(&mut self, pages: u32) -> Result<u32>;
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
/// One relocated core instance in a group memory.
pub(super) struct Member {
    pub(super) instance: Instance,
    pub(super) memory_base: u32,
    pub(super) table: Table,
    pub(super) stack_pointer: Global,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
/// Instantiate a shared-group core into `memory` at freshly carved data and stack chunks, with
/// its own table (slot 0 null), then run its explicit initialization in order.
pub(super) fn instantiate_core<T: 'static>(
    store: &mut Store<T>,
    linker: &Linker<T>,
    module: &Module,
    layout: &MemInfo,
    memory: &SharedMemory,
    placement: &mut dyn Placement,
) -> Result<Member> {
    ensure!(
        layout.memory_alignment <= 16,
        "member data alignment exceeds a page"
    );
    let data_pages = layout.memory_size.div_ceil(PAGE).max(1);
    let data = placement.carve(data_pages)?;
    let stack_pages = STACK_BYTES / PAGE;
    let stack = placement.carve(stack_pages)?;
    let memory_base = page_address(data)?;
    let stack_top = page_address(stack + stack_pages)?;
    let table_base = 1_u64.next_multiple_of(1 << layout.table_alignment);
    let table_type = TableType::new(
        RefType::FUNCREF,
        u32::try_from(table_base + u64::from(layout.table_size)).context("member table")?,
        None,
    );
    let table = Table::new(&mut *store, table_type, Ref::Func(None))?;
    let stack_pointer = i32_global(store, stack_top, Mutability::Var)?;
    let mut imports = linker.clone();
    let base = i32_global(store, memory_base, Mutability::Const)?;
    let table_base = i32_global(store, table_base as u32, Mutability::Const)?;
    let env: [(&str, Extern); 5] = [
        ("memory", memory.clone().into()),
        ("__indirect_function_table", table.into()),
        ("__memory_base", base.into()),
        ("__table_base", table_base.into()),
        ("__stack_pointer", stack_pointer.into()),
    ];
    for (name, value) in env {
        imports.define(&*store, "env", name, value)?;
    }
    let instance = imports.instantiate(&mut *store, module)?;
    for name in CORE_INITIALIZE {
        instance
            .get_typed_func::<(), ()>(&mut *store, name)?
            .call(&mut *store, ())
            .with_context(|| format!("initializing {name}"))?;
    }
    Ok(Member {
        instance,
        memory_base,
        table,
        stack_pointer,
    })
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
fn page_address(page: u32) -> Result<u32> {
    let address = u64::from(page) * u64::from(PAGE);
    ensure!(
        address <= MAX_PAGES * u64::from(PAGE),
        "member chunk exceeds the group maximum"
    );
    u32::try_from(address).context("member chunk exceeds wasm32")
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the runtime_shm group host links members through this boundary"
    )
)]
fn i32_global<T>(store: &mut Store<T>, value: u32, mutability: Mutability) -> Result<Global> {
    Global::new(
        store,
        GlobalType::new(ValType::I32, mutability),
        Val::I32(value as i32),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_encoder::{
        CodeSection, CustomSection, EntityType, ExportKind, ExportSection, Function,
        FunctionSection, GlobalType as EncodedGlobal, ImportSection, Instruction, MemArg,
        MemoryType, StartSection, TableType as EncodedTable, TypeSection, ValType as EncodedValue,
    };
    use wasmtime::{Config, Engine, MemoryType as HostMemory};

    #[derive(Clone, Copy)]
    struct Image {
        shared: bool,
        maximum: Option<u64>,
        dylink: bool,
        needed: bool,
        grow: bool,
        export_memory: bool,
        start: bool,
    }

    const CORE: Image = Image {
        shared: true,
        maximum: Some(MAX_PAGES),
        dylink: true,
        needed: false,
        grow: false,
        export_memory: false,
        start: false,
    };

    fn dylink(needed: bool) -> Vec<u8> {
        // memory-info: size 8, alignment 2^2, table size 0, alignment 0.
        let mut payload = vec![1, 4, 8, 2, 0, 0];
        if needed {
            payload.extend([2, 6, 1, 4]);
            payload.extend(b"x.so");
        }
        payload
    }

    fn store_word(offset: u64, value: Instruction<'static>) -> Vec<Instruction<'static>> {
        vec![
            Instruction::GlobalGet(1),
            value,
            Instruction::I32Store(MemArg {
                offset,
                align: 2,
                memory_index: 0,
            }),
        ]
    }

    /// A hand-made PIE core: data word 0 is written by `core_initialize_memory`, word 1 holds
    /// the instance's own base after `__wasm_apply_data_relocs`, and `value` reads word 1.
    fn image(spec: Image) -> Vec<u8> {
        let mut types = TypeSection::new();
        types.ty().function([], []);
        types.ty().function([], [EncodedValue::I32]);
        let mut imports = ImportSection::new();
        let memory = MemoryType {
            minimum: 1,
            maximum: spec.maximum,
            memory64: false,
            shared: spec.shared,
            page_size_log2: None,
        };
        imports.import("env", "memory", memory);
        let global = |mutable| EncodedGlobal {
            val_type: EncodedValue::I32,
            mutable,
            shared: false,
        };
        imports.import("env", "__stack_pointer", EntityType::Global(global(true)));
        imports.import("env", "__memory_base", EntityType::Global(global(false)));
        imports.import("env", "__table_base", EntityType::Global(global(false)));
        let table = EncodedTable {
            element_type: wasm_encoder::RefType::FUNCREF,
            table64: false,
            minimum: 1,
            maximum: None,
            shared: false,
        };
        imports.import("env", "__indirect_function_table", table);
        let mut functions = FunctionSection::new();
        for ty in [0, 0, 0, 0, 1] {
            functions.function(ty);
        }
        let mut exports = ExportSection::new();
        let names = CORE_INITIALIZE.into_iter().chain(["_start", "value"]);
        for (index, name) in names.enumerate() {
            exports.export(name, ExportKind::Func, index as u32);
        }
        if spec.export_memory {
            exports.export("memory", ExportKind::Memory, 0);
        }
        let mut code = CodeSection::new();
        let mut init = store_word(0, Instruction::I32Const(42));
        if spec.grow {
            init.extend([
                Instruction::I32Const(0),
                Instruction::MemoryGrow(0),
                Instruction::Drop,
            ]);
        }
        let relocate = store_word(4, Instruction::GlobalGet(1));
        let read = vec![
            Instruction::GlobalGet(1),
            Instruction::I32Load(MemArg {
                offset: 4,
                align: 2,
                memory_index: 0,
            }),
        ];
        for body in [init, relocate, Vec::new(), Vec::new(), read] {
            let mut function = Function::new([]);
            for instruction in &body {
                function.instruction(instruction);
            }
            function.instruction(&Instruction::End);
            code.function(&function);
        }
        let mut module = wasm_encoder::Module::new();
        if spec.dylink {
            module.section(&CustomSection {
                name: "dylink.0".into(),
                data: dylink(spec.needed).into(),
            });
        }
        module
            .section(&types)
            .section(&imports)
            .section(&functions)
            .section(&exports);
        if spec.start {
            module.section(&StartSection { function_index: 0 });
        }
        module.section(&code);
        module.finish()
    }

    #[test]
    fn a_pie_core_is_admitted_and_a_split_core_is_left_alone() {
        assert_eq!(admit(&image(CORE), true).unwrap(), Profile::SharedGroup);
        let split = Image {
            dylink: false,
            shared: false,
            maximum: None,
            ..CORE
        };
        assert_eq!(admit(&image(split), true).unwrap(), Profile::Split);
    }

    #[test]
    fn group_images_that_could_escape_the_owner_are_refused() {
        let refused = [
            Image { grow: true, ..CORE },
            Image {
                export_memory: true,
                ..CORE
            },
            Image {
                shared: false,
                ..CORE
            },
            Image {
                maximum: Some(65_536),
                ..CORE
            },
            Image {
                needed: true,
                ..CORE
            },
            Image {
                start: true,
                ..CORE
            },
        ];
        for spec in refused {
            assert!(admit(&image(spec), true).is_err());
        }
    }

    #[test]
    fn a_shared_side_is_a_group_image_and_cannot_grow() {
        let side = Image {
            maximum: Some(65_536),
            ..CORE
        };
        assert_eq!(admit(&image(side), false).unwrap(), Profile::SharedGroup);
        assert!(admit(&image(Image { grow: true, ..side }), false).is_err());
        let split = Image {
            shared: false,
            maximum: None,
            ..side
        };
        assert_eq!(admit(&image(split), false).unwrap(), Profile::Split);
    }

    struct Ledger {
        next: u32,
        chunks: Vec<(u32, u32)>,
    }

    impl Placement for Ledger {
        fn carve(&mut self, pages: u32) -> Result<u32> {
            let first = self.next;
            self.next += pages;
            self.chunks.push((first, self.next));
            Ok(first)
        }
    }

    #[test]
    fn two_members_initialize_their_own_data_in_one_shared_memory() {
        let mut config = Config::new();
        config.wasm_threads(true);
        let engine = Engine::new(&config).unwrap();
        let module = Module::new(&engine, image(CORE)).unwrap();
        let memory = SharedMemory::new(&engine, HostMemory::shared(1, MAX_PAGES as u32)).unwrap();
        let mut store = Store::new(&engine, ());
        let linker = Linker::new(&engine);
        let layout = MemInfo {
            memory_size: 8,
            memory_alignment: 2,
            table_size: 0,
            table_alignment: 0,
        };
        let mut ledger = Ledger {
            next: 1,
            chunks: Vec::new(),
        };
        let mut members = Vec::new();
        for _ in 0..2 {
            let needed = ledger.next + 1 + STACK_BYTES / PAGE;
            memory.grow(u64::from(needed) - memory.size()).unwrap();
            let member =
                instantiate_core(&mut store, &linker, &module, &layout, &memory, &mut ledger)
                    .unwrap();
            members.push(member);
        }
        let bases: Vec<u32> = members.iter().map(|member| member.memory_base).collect();
        assert_ne!(bases[0], bases[1]);
        for member in &members {
            let value = member
                .instance
                .get_typed_func::<(), i32>(&mut store, "value")
                .unwrap()
                .call(&mut store, ())
                .unwrap();
            assert_eq!(value as u32, member.memory_base);
            let word = &memory.data()[member.memory_base as usize..][..4];
            let bytes: Vec<u8> = word.iter().map(|cell| unsafe { *cell.get() }).collect();
            assert_eq!(u32::from_le_bytes(bytes.try_into().unwrap()), 42);
            assert_eq!(member.table.size(&store), 1);
            let top = member.stack_pointer.get(&mut store).unwrap_i32() as u32;
            assert_eq!(top % PAGE, 0);
            assert!(top > member.memory_base);
        }
        assert!(ledger.chunks.windows(2).all(|pair| pair[0].1 <= pair[1].0));
    }
}
