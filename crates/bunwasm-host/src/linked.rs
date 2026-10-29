use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{Dylink0Subsection, KnownCustom, MemInfo, Parser, Payload};
use wasmtime::{
    Engine, Extern, ExternType, Func, Global, GlobalType, Instance, Linker, Module, Mutability,
    Ref, Store, Table, Val, ValType,
};

use crate::Host;
use crate::guest::GuestMemory;
use crate::shm::{GroupBackingBudget, MemberLease, MemoryGroup};

#[path = "linked_relay.rs"]
mod relay;
use relay::{SelfPlan, SelfSlots};
#[path = "linked_group.rs"]
mod group;
#[path = "linked_preview1.rs"]
mod preview1;
pub use group::{Admission, MemberImage};

#[derive(Default)]
pub struct Programs {
    programs: Vec<Program>,
    /// One runtime-wide committed-backing budget shared by every memory group (W3).
    budget: GroupBackingBudget,
}

struct Program {
    core: Module,
    library: Module,
    layout: MemInfo,
    kind: ProgramKind,
    self_plan: SelfPlan,
    /// A shared-group core's layout and base-relative exports.
    group: Option<group::CoreLayout>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProgramKind {
    QuickJs,
    Jsc,
}

impl ProgramKind {
    fn companion(self) -> &'static str {
        match self {
            Self::QuickJs => "quickjs.wasm",
            Self::Jsc => "jsc-engine.wasm",
        }
    }

    fn initializers(self) -> &'static [&'static str] {
        match self {
            Self::QuickJs => &[
                "quickjs_initialize_memory",
                "quickjs_apply_data_relocs",
                "quickjs_call_ctors",
                "quickjs_register",
            ],
            Self::Jsc => &[
                "jsc_initialize_memory",
                "jsc_apply_data_relocs",
                "jsc_call_ctors",
                "jsc_register",
            ],
        }
    }

    fn run(self) -> &'static str {
        match self {
            Self::QuickJs => "quickjs_run",
            Self::Jsc => "jsc_run",
        }
    }

    fn other_profile(self) -> ProgramKind {
        match self {
            Self::QuickJs => Self::Jsc,
            Self::Jsc => Self::QuickJs,
        }
    }
}

impl Programs {
    pub fn load(&mut self, engine: &Engine, path: &Path) -> Result<Module> {
        let core_bytes =
            std::fs::read(path).with_context(|| format!("loading {}", path.display()))?;
        let core = Module::new(engine, &core_bytes)
            .with_context(|| format!("loading {}", path.display()))?;
        let has_bind = core_bind_is_function(&core)?;
        let kind = parse_program_kind(&core_bytes, has_bind)?;
        let profile = group::admit(&core_bytes, true)
            .with_context(|| format!("admitting {}", path.display()))?;
        let Some(kind) = kind else {
            ensure!(
                profile == group::Profile::Split,
                "a memory group image runs only as a member of a linked program"
            );
            return Ok(core);
        };
        let path = path.with_file_name(kind.companion());
        let bytes = std::fs::read(&path)
            .with_context(|| format!("loading paired {:?} engine {}", kind, path.display()))?;
        let side = group::admit(&bytes, false)
            .with_context(|| format!("admitting paired {:?} engine {}", kind, path.display()))?;
        ensure!(
            side == profile,
            "paired {kind:?} engine profile {side:?} does not match core profile {profile:?}"
        );
        let group = match profile {
            group::Profile::Split => None,
            group::Profile::SharedGroup => Some(&core_bytes),
        };
        let layout = layout(&bytes)?;
        let library = Module::new(engine, &bytes)?;
        let group = group
            .map(|bytes| group::CoreLayout::read(engine, bytes, &core, &library))
            .transpose()?;
        validate_profile(kind, &library)?;
        let self_plan = SelfPlan::new(engine, &core, &library, &bytes)?;
        self.programs.push(Program {
            core: core.clone(),
            library,
            layout,
            kind,
            self_plan,
            group,
        });
        Ok(core)
    }

    /// Executable admission clones Modules. Keep the original image alive with its pair.
    fn program(&self, module: &Module) -> Option<&Program> {
        self.programs
            .iter()
            .find(|program| program.core.image_range() == module.image_range())
    }

    /// Whether `module` is the core of an admitted shared-group program.
    pub fn is_group(&self, module: &Module) -> bool {
        self.program(module)
            .is_some_and(|program| program.group.is_some())
    }

    /// The slot a worker of a group member reserves in its parent's group before its thread
    /// starts (`EAGAIN` when the group is full); `None` for every other spawn.
    pub fn worker_admission(
        &self,
        parent: Option<&MemoryGroup>,
        worker: bool,
        module: &Module,
        pid: u32,
    ) -> Result<Option<Admission>, i32> {
        group::worker_admission(parent, worker, self.is_group(module), pid)
    }

    /// The membership of a process about to run `module`: its inherited slot, the first slot of
    /// a new group on the runtime-wide budget, or none for a split program.
    pub fn member(
        &self,
        module: &Module,
        pid: u32,
        admission: Option<Admission>,
    ) -> Result<Option<MemberLease>> {
        group::member(
            module.engine(),
            &self.budget,
            self.is_group(module),
            pid,
            admission,
        )
    }

    /// Instantiate a program's core. A shared-group core is a member image: its data and stack
    /// are carved through the member lease in `Host::shm`, and its memory is initialized here.
    ///
    /// # Safety
    ///
    /// For a group program, the caller keeps a lease of the member's group backing
    /// (`MemberLease::group().memory_lease()`) alive until `store` and every instance in it
    /// have dropped. Wasmtime drops a Store's data before its instances, so the lease held in
    /// `Host` is not enough on its own.
    pub unsafe fn instantiate(
        &self,
        module: &Module,
        linker: &mut Linker<Host>,
        store: &mut Store<Host>,
    ) -> Result<(Instance, Option<MemberImage>)> {
        let Some(core) = self
            .program(module)
            .and_then(|program| program.group.as_ref())
        else {
            return Ok((linker.instantiate(&mut *store, module)?, None));
        };
        let lease = store
            .data()
            .shm
            .as_ref()
            .context("a memory group program needs a member lease")?;
        let placement = group::carve(lease, &core.layout)?;
        let memory = lease.group().memory_lease();
        // Preview1 reaches the member's memory only through its view, for the core and side.
        // SAFETY: both admissions are covered by this function's contract.
        unsafe { core.preview1.bind(store, linker, &memory) }?;
        let (instance, image) = unsafe {
            group::instantiate_core(store, linker, module, &core.layout, &memory, &placement)
        }?;
        Ok((instance, Some(image)))
    }

    pub fn initialize(
        &self,
        module: &Module,
        core: Instance,
        member: Option<&MemberImage>,
        linker: &Linker<Host>,
        store: &mut Store<Host>,
    ) -> Result<()> {
        let Some(program) = self.program(module) else {
            return Ok(());
        };
        core.get_typed_func::<(), ()>(&mut *store, "__wasm_call_ctors")?
            .call(&mut *store, ())?;
        let image = match (member, &program.group) {
            (None, None) => CoreImage::split(core, store)?,
            (Some(member), Some(group)) => CoreImage::member(core, member, &group.relative),
            _ => bail!("program core and member image disagree on the memory group profile"),
        };
        program.initialize(&image, linker, store)
    }
}

fn core_bind_is_function(core: &Module) -> Result<bool> {
    match core.get_export("bun_core_bind_engine") {
        None => Ok(false),
        Some(ExternType::Func(_)) => Ok(true),
        Some(_) => bail!("bun_core_bind_engine must be a function"),
    }
}

fn parse_program_kind(bytes: &[u8], has_bind: bool) -> Result<Option<ProgramKind>> {
    let mut tag = None;
    for payload in Parser::new(0).parse_all(bytes) {
        let Payload::CustomSection(section) = payload? else {
            continue;
        };
        if section.name() != "bun-wasm-engine" {
            continue;
        }
        ensure!(tag.is_none(), "duplicate bun-wasm-engine section");
        let kind = match section.data() {
            b"quickjs" => ProgramKind::QuickJs,
            b"jsc" => ProgramKind::Jsc,
            _ => bail!("invalid bun-wasm-engine payload"),
        };
        tag = Some(kind);
    }
    match (has_bind, tag) {
        (true, Some(kind)) => Ok(Some(kind)),
        (true, None) => bail!("engine bind export requires bun-wasm-engine section"),
        (false, Some(_)) => bail!("single module cannot declare bun-wasm-engine"),
        (false, None) => Ok(None),
    }
}

fn validate_profile(kind: ProgramKind, side: &Module) -> Result<()> {
    for name in kind.initializers().iter().copied() {
        ensure!(
            function_signature(side, name, &[], &[]),
            "paired {:?} side is missing initializer function {name}",
            kind
        );
    }
    ensure!(
        function_signature(side, kind.run(), &[ValType::I32], &[ValType::I32]),
        "paired {:?} side has invalid RUN function {}",
        kind,
        kind.run()
    );
    let other = kind.other_profile();
    for name in other.initializers().iter().copied().chain([other.run()]) {
        ensure!(
            side.get_export(name).is_none(),
            "paired {:?} side exports wrong profile symbol {name}",
            kind
        );
    }
    Ok(())
}

fn function_signature(
    module: &Module,
    name: &str,
    params: &[ValType],
    results: &[ValType],
) -> bool {
    let Some(ExternType::Func(function)) = module.get_export(name) else {
        return false;
    };
    same_types(function.params(), params) && same_types(function.results(), results)
}

// wasmtime's ValType is neither Copy nor PartialEq; ValType::eq compares structurally.
fn same_types(actual: impl ExactSizeIterator<Item = ValType>, expected: &[ValType]) -> bool {
    actual.len() == expected.len() && actual.zip(expected).all(|(a, b)| ValType::eq(&a, b))
}

fn layout(bytes: &[u8]) -> Result<MemInfo> {
    let mut info = None;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::StartSection { .. } => bail!("paired engine must use explicit initialization"),
            Payload::CustomSection(section) => read_layout(section.as_known(), &mut info)?,
            _ => {}
        }
    }
    let info = info.context("paired engine has no dylink.0 memory layout")?;
    ensure!(
        info.memory_alignment <= 31 && info.table_alignment <= 31,
        "paired engine alignment exceeds wasm32"
    );
    Ok(info)
}

fn read_layout(section: KnownCustom<'_>, info: &mut Option<MemInfo>) -> Result<()> {
    let KnownCustom::Dylink0(sections) = section else {
        return Ok(());
    };
    for section in sections {
        read_layout_item(section?, info)?;
    }
    Ok(())
}

fn read_layout_item(section: Dylink0Subsection<'_>, info: &mut Option<MemInfo>) -> Result<()> {
    match section {
        Dylink0Subsection::MemInfo(layout) => {
            ensure!(
                info.replace(layout).is_none(),
                "duplicate paired engine layout"
            );
        }
        Dylink0Subsection::Needed(names) if names.is_empty() => {}
        _ => bail!("unsupported paired engine dylink subsection"),
    }
    Ok(())
}

impl Program {
    fn initialize(
        &self,
        core: &CoreImage<'_>,
        linker: &Linker<Host>,
        store: &mut Store<Host>,
    ) -> Result<()> {
        let table = core.table;
        let size = self.layout.memory_size.max(1);
        let alignment = 1_u32 << self.layout.memory_alignment;
        let base = core
            .instance
            .get_typed_func::<(u32, u32), u32>(&mut *store, "bun_core_alloc")?
            .call(&mut *store, (size, alignment))?;
        ensure!(
            base != 0 && base.is_multiple_of(alignment),
            "invalid core memory reservation"
        );
        let end = u64::from(base) + u64::from(size);
        ensure!(
            end <= core.memory.len(&*store) as u64,
            "side reservation exceeds core memory"
        );
        let reservation = base as usize..end as usize;
        let zeroed = reservation.len();
        core.memory
            .fill(&mut *store, reservation, |bytes, _| {
                bytes.fill(0);
                zeroed as i32
            })
            .context("side reservation")?;
        let alignment = 1_u64 << self.layout.table_alignment;
        let table_base = table.size(&*store).max(1).div_ceil(alignment) * alignment;
        let table_end = table_base + u64::from(self.layout.table_size.max(1));
        ensure!(
            table_end <= u64::from(u32::MAX),
            "side table exceeds wasm32"
        );
        let growth = table_end - table.size(&*store);
        table.grow(&mut *store, growth, Ref::Func(None))?;
        let slots = self.self_plan.reserve(store, table)?;
        let mut imports = linker.clone();
        self.imports(core, &mut imports, store, base, table_base as u32, &slots)?;
        let side = imports.instantiate(&mut *store, &self.library)?;
        self.self_plan.bind(store, table, &slots, side)?;
        for name in self.kind.initializers().iter().copied() {
            side.get_typed_func::<(), ()>(&mut *store, name)?
                .call(&mut *store, ())
                .with_context(|| format!("initializing {name}"))?;
        }
        Ok(())
    }

    fn imports(
        &self,
        core: &CoreImage<'_>,
        linker: &mut Linker<Host>,
        store: &mut Store<Host>,
        memory: u32,
        table: u32,
        slots: &SelfSlots,
    ) -> Result<()> {
        for import in self.library.imports() {
            let name = import.name();
            let own = self.self_plan.slot(name);
            let value = match (import.module(), name) {
                ("env", "__memory_base") => address_global(store, memory, Mutability::Const)?,
                ("env", "__table_base") => address_global(store, table, Mutability::Const)?,
                ("env", name) => env_value(core, store, name, own, slots)?,
                ("GOT.mem", name) => got_address(core, store, name)?,
                ("GOT.func", name) => function_cell(core, store, name, own, slots)?,
                ("wasi_snapshot_preview1", _) => continue,
                (namespace, _) => bail!("unsupported side import {namespace}.{name}"),
            };
            linker.define(&*store, import.module(), name, value)?;
        }
        Ok(())
    }
}

/// The core a side links into: its memory and table, plus a member image's own stack pointer
/// and the base that rebases its relative data exports.
struct CoreImage<'a> {
    instance: Instance,
    memory: GuestMemory,
    table: Table,
    stack_pointer: Option<Global>,
    base: u32,
    relative: Option<&'a HashSet<String>>,
}

impl<'a> CoreImage<'a> {
    fn split(instance: Instance, store: &mut Store<Host>) -> Result<Self> {
        let memory = instance
            .get_memory(&mut *store, "memory")
            .context("core memory")?;
        let table = instance
            .get_table(&mut *store, "__indirect_function_table")
            .context("core table")?;
        Ok(Self {
            instance,
            memory: GuestMemory::Private(memory),
            table,
            stack_pointer: None,
            base: 0,
            relative: None,
        })
    }

    fn member(instance: Instance, member: &MemberImage, relative: &'a HashSet<String>) -> Self {
        Self {
            instance,
            memory: GuestMemory::Shared(member.memory.clone()),
            table: member.table,
            stack_pointer: Some(member.stack_pointer),
            base: member.memory_base,
            relative: Some(relative),
        }
    }

    /// The address a core data export names. A member's constant exports are base-relative.
    fn data_address(&self, name: &str, value: u32) -> u32 {
        let relative = self.relative.is_some_and(|names| names.contains(name));
        if relative {
            value.wrapping_add(self.base)
        } else {
            value
        }
    }
}

/// The member's own memory, table and stack pointer; everything else comes from the core.
fn env_value(
    core: &CoreImage<'_>,
    store: &mut Store<Host>,
    name: &str,
    own: Option<u32>,
    slots: &SelfSlots,
) -> Result<Extern> {
    match (name, core.stack_pointer) {
        // SAFETY: a member image exists only through `Programs::instantiate`, whose caller keeps
        // the group backing alive past this Store and its side instance.
        ("memory", _) => Ok(unsafe { core.memory.export_for_admission() }),
        ("__indirect_function_table", _) => Ok(core.table.into()),
        ("__stack_pointer", Some(stack_pointer)) => Ok(stack_pointer.into()),
        _ => env_export(core.instance, store, name, own, slots),
    }
}

fn env_export(
    core: Instance,
    store: &mut Store<Host>,
    name: &str,
    own: Option<u32>,
    slots: &SelfSlots,
) -> Result<Extern> {
    match (core.get_export(&mut *store, name), own) {
        (Some(export), _) => Ok(export),
        (None, Some(slot)) => slots.relay(store, slot),
        (None, None) => bail!("missing core export {name}"),
    }
}

fn function_cell(
    core: &CoreImage<'_>,
    store: &mut Store<Host>,
    name: &str,
    own: Option<u32>,
    slots: &SelfSlots,
) -> Result<Extern> {
    match own {
        Some(slot) => address_global(store, slots.address(slot), Mutability::Var),
        None => got_function(core.instance, store, name, core.table),
    }
}

fn address_global<T>(store: &mut Store<T>, value: u32, mutability: Mutability) -> Result<Extern> {
    Ok(Global::new(
        store,
        GlobalType::new(ValType::I32, mutability),
        Val::I32(value as i32),
    )?
    .into())
}

fn got_address<T>(core: &CoreImage<'_>, store: &mut Store<T>, name: &str) -> Result<Extern> {
    let symbol = core
        .instance
        .get_global(&mut *store, name)
        .with_context(|| format!("missing core GOT address {name}"))?;
    ensure!(
        symbol.ty(&*store).mutability() == Mutability::Const,
        "GOT address must be immutable"
    );
    let value = symbol
        .get(&mut *store)
        .i32()
        .context("GOT address must be i32")? as u32;
    let value = core.data_address(name, value);
    ensure!(
        data_address(name, value, core.memory.len(&*store)),
        "GOT.mem.{name} address is outside core memory"
    );
    address_global(store, value, Mutability::Var)
}

/// Data symbols are nonzero addresses inside memory. The linker's stack bounds may sit at
/// either edge: a stack-first core has `__stack_low` at 0.
fn data_address(name: &str, address: u32, memory_size: usize) -> bool {
    let address = address as usize;
    if matches!(name, "__stack_low" | "__stack_high") {
        return address <= memory_size;
    }
    address != 0 && address < memory_size
}

/// The table slot of a core function, so the side's `&f` equals the core's. A function not
/// yet in the table gets one new slot.
fn got_function<T>(
    core: Instance,
    store: &mut Store<T>,
    name: &str,
    table: Table,
) -> Result<Extern> {
    let function = core
        .get_func(&mut *store, name)
        .with_context(|| format!("GOT.func.{name} requires a core function export"))?;
    let slot = match table_slot(store, table, function) {
        Some(slot) => slot,
        None => table.grow(&mut *store, 1, Ref::Func(Some(function)))?,
    };
    let slot = u32::try_from(slot).context("GOT.func slot exceeds wasm32")?;
    address_global(store, slot, Mutability::Var)
}

fn table_slot<T>(store: &mut Store<T>, table: Table, function: Func) -> Option<u64> {
    let target = function.to_raw(&mut *store);
    (0..table.size(&*store)).find(|&slot| match table.get(&mut *store, slot) {
        Some(Ref::Func(Some(entry))) => entry.to_raw(&mut *store) == target,
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wasm_custom(name: &[u8], data: &[u8]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.push(name.len() as u8);
        payload.extend_from_slice(name);
        payload.extend_from_slice(data);
        vec![
            0x00,
            0x61,
            0x73,
            0x6d,
            0x01,
            0x00,
            0x00,
            0x00,
            0x00,
            payload.len() as u8,
        ]
        .into_iter()
        .chain(payload)
        .collect()
    }

    #[test]
    fn engine_tag_requires_bind_export() {
        let bytes = wasm_custom(b"bun-wasm-engine", b"jsc");
        assert!(parse_program_kind(&bytes, false).is_err());
        assert_eq!(
            parse_program_kind(&bytes, true).unwrap(),
            Some(ProgramKind::Jsc)
        );
    }

    #[test]
    fn engine_tag_rejects_duplicates_and_unknown_payloads() {
        let duplicate: Vec<u8> = {
            let first = wasm_custom(b"bun-wasm-engine", b"quickjs");
            let second = wasm_custom(b"bun-wasm-engine", b"quickjs");
            first[..8]
                .iter()
                .copied()
                .chain(
                    first[8..]
                        .iter()
                        .copied()
                        .chain(second[8..].iter().copied()),
                )
                .collect()
        };
        assert!(parse_program_kind(&duplicate, true).is_err());

        let invalid = wasm_custom(b"bun-wasm-engine", b"other");
        assert!(parse_program_kind(&invalid, true).is_err());
    }

    #[test]
    fn stack_bounds_may_sit_at_either_memory_edge() {
        let size = 3 * 65_536;
        assert!(data_address("__stack_low", 0, size));
        assert!(data_address("__stack_high", size as u32, size));
        assert!(!data_address("__stack_high", size as u32 + 1, size));
        assert!(data_address("errno", 1024, size));
        assert!(!data_address("errno", 0, size));
        assert!(!data_address("errno", size as u32, size));
    }

    /// A core with `tabled` already at table slot 1, `loose` in no slot, and a global.
    fn function_core() -> Vec<u8> {
        use wasm_encoder::{
            CodeSection, ConstExpr, ElementSection, Elements, ExportKind, ExportSection, Function,
            FunctionSection, GlobalSection, GlobalType, Instruction, RefType, TableSection,
            TableType, TypeSection, ValType,
        };
        let mut types = TypeSection::new();
        types.ty().function([], []);
        let mut functions = FunctionSection::new();
        functions.function(0).function(0);
        let mut tables = TableSection::new();
        tables.table(TableType {
            element_type: RefType::FUNCREF,
            table64: false,
            minimum: 2,
            maximum: None,
            shared: false,
        });
        let mut globals = GlobalSection::new();
        let ty = GlobalType {
            val_type: ValType::I32,
            mutable: false,
            shared: false,
        };
        globals.global(ty, &ConstExpr::i32_const(16));
        let mut exports = ExportSection::new();
        exports
            .export("__indirect_function_table", ExportKind::Table, 0)
            .export("tabled", ExportKind::Func, 0)
            .export("loose", ExportKind::Func, 1)
            .export("value", ExportKind::Global, 0);
        let mut elements = ElementSection::new();
        elements.active(
            Some(0),
            &ConstExpr::i32_const(1),
            Elements::Functions([0].as_slice().into()),
        );
        let mut code = CodeSection::new();
        for _ in 0..2 {
            let mut body = Function::new([]);
            body.instruction(&Instruction::End);
            code.function(&body);
        }
        let mut module = wasm_encoder::Module::new();
        module
            .section(&types)
            .section(&functions)
            .section(&tables)
            .section(&globals)
            .section(&exports)
            .section(&elements)
            .section(&code);
        module.finish()
    }

    fn got_slot(core: Instance, store: &mut Store<()>, name: &str) -> Result<i32> {
        let table = core
            .get_table(&mut *store, "__indirect_function_table")
            .unwrap();
        let Extern::Global(global) = got_function(core, store, name, table)? else {
            bail!("GOT.func cell is not a global");
        };
        Ok(global.get(&mut *store).unwrap_i32())
    }

    #[test]
    fn function_cells_reuse_the_core_table_slot() {
        let engine = Engine::default();
        let module = Module::new(&engine, function_core()).unwrap();
        let mut store = Store::new(&engine, ());
        let core = Instance::new(&mut store, &module, &[]).unwrap();
        let table = core
            .get_table(&mut store, "__indirect_function_table")
            .unwrap();
        assert_eq!(got_slot(core, &mut store, "tabled").unwrap(), 1);
        assert_eq!(table.size(&store), 2);
        assert_eq!(got_slot(core, &mut store, "loose").unwrap(), 2);
        assert_eq!(got_slot(core, &mut store, "loose").unwrap(), 2);
        assert_eq!(table.size(&store), 3);
        assert!(got_slot(core, &mut store, "value").is_err());
        assert!(got_slot(core, &mut store, "missing").is_err());
    }

    #[test]
    fn profiles_have_fixed_companion_and_entry_names() {
        assert_eq!(ProgramKind::QuickJs.companion(), "quickjs.wasm");
        assert_eq!(ProgramKind::Jsc.companion(), "jsc-engine.wasm");
        assert_eq!(ProgramKind::Jsc.run(), "jsc_run");
        assert!(ProgramKind::Jsc.initializers().contains(&"jsc_register"));
    }
}
