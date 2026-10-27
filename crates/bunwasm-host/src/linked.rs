use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{Dylink0Subsection, KnownCustom, MemInfo, Parser, Payload};
use wasmtime::{
    Engine, Extern, ExternType, Global, GlobalType, Instance, Linker, Module, Mutability, Ref,
    Store, Val, ValType,
};

use crate::Host;

#[derive(Default)]
pub struct Programs(Vec<Program>);

struct Program {
    core: Module,
    library: Module,
    layout: MemInfo,
    kind: ProgramKind,
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
        let has_bind = core_bind_is_function(&Module::new(engine, &core_bytes)?)?;
        let kind = parse_program_kind(&core_bytes, has_bind)?;
        let core = Module::new(engine, &core_bytes)
            .with_context(|| format!("loading {}", path.display()))?;
        let Some(kind) = kind else {
            return Ok(core);
        };
        let path = path.with_file_name(kind.companion());
        let bytes = std::fs::read(&path)
            .with_context(|| format!("loading paired {:?} engine {}", kind, path.display()))?;
        let layout = layout(&bytes)?;
        let library = Module::new(engine, bytes)?;
        validate_profile(kind, &library)?;
        self.0.push(Program {
            core: core.clone(),
            library,
            layout,
            kind,
        });
        Ok(core)
    }

    pub fn initialize(
        &self,
        module: &Module,
        core: Instance,
        linker: &Linker<Host>,
        store: &mut Store<Host>,
    ) -> Result<()> {
        // Executable admission clones Modules. Keep the original image alive with its pair.
        let program = self
            .0
            .iter()
            .find(|program| program.core.image_range() == module.image_range());
        let Some(program) = program else {
            return Ok(());
        };
        core.get_typed_func::<(), ()>(&mut *store, "__wasm_call_ctors")?
            .call(&mut *store, ())?;
        program.initialize(core, linker, store)
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
        core: Instance,
        linker: &Linker<Host>,
        store: &mut Store<Host>,
    ) -> Result<()> {
        let memory = core
            .get_memory(&mut *store, "memory")
            .context("core memory")?;
        let table = core
            .get_table(&mut *store, "__indirect_function_table")
            .context("core table")?;
        let size = self.layout.memory_size.max(1);
        let alignment = 1_u32 << self.layout.memory_alignment;
        let base = core
            .get_typed_func::<(u32, u32), u32>(&mut *store, "bun_core_alloc")?
            .call(&mut *store, (size, alignment))?;
        ensure!(
            base != 0 && base.is_multiple_of(alignment),
            "invalid core memory reservation"
        );
        let end = u64::from(base) + u64::from(size);
        ensure!(
            end <= memory.data_size(&*store) as u64,
            "side reservation exceeds core memory"
        );
        memory.data_mut(&mut *store)[base as usize..end as usize].fill(0);
        let alignment = 1_u64 << self.layout.table_alignment;
        let table_base = table.size(&*store).max(1).div_ceil(alignment) * alignment;
        let table_end = table_base + u64::from(self.layout.table_size.max(1));
        ensure!(
            table_end <= u64::from(u32::MAX),
            "side table exceeds wasm32"
        );
        let growth = table_end - table.size(&*store);
        table.grow(&mut *store, growth, Ref::Func(None))?;
        let mut imports = linker.clone();
        self.imports(core, &mut imports, store, base, table_base as u32)?;
        let side = imports.instantiate(&mut *store, &self.library)?;
        for name in self.kind.initializers().iter().copied() {
            side.get_typed_func::<(), ()>(&mut *store, name)?
                .call(&mut *store, ())
                .with_context(|| format!("initializing {name}"))?;
        }
        Ok(())
    }

    fn imports(
        &self,
        core: Instance,
        linker: &mut Linker<Host>,
        store: &mut Store<Host>,
        memory: u32,
        table: u32,
    ) -> Result<()> {
        for import in self.library.imports() {
            let name = import.name();
            let value = match (import.module(), name) {
                ("env", "__memory_base") => address_global(store, memory, Mutability::Const)?,
                ("env", "__table_base") => address_global(store, table, Mutability::Const)?,
                ("env", name) => core
                    .get_export(&mut *store, name)
                    .with_context(|| format!("missing core export {name}"))?,
                ("GOT.mem", name) => got_address(core, store, name)?,
                ("wasi_snapshot_preview1", _) => continue,
                (namespace, _) => bail!("unsupported side import {namespace}.{name}"),
            };
            linker.define(&*store, import.module(), name, value)?;
        }
        Ok(())
    }
}

fn address_global(store: &mut Store<Host>, value: u32, mutability: Mutability) -> Result<Extern> {
    Ok(Global::new(
        store,
        GlobalType::new(ValType::I32, mutability),
        Val::I32(value as i32),
    )?
    .into())
}

fn got_address(core: Instance, store: &mut Store<Host>, name: &str) -> Result<Extern> {
    let symbol = core
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
    let memory = core
        .get_memory(&mut *store, "memory")
        .context("core memory")?;
    ensure!(
        value != 0 && (value as usize) < memory.data_size(&*store),
        "GOT address outside core memory"
    );
    address_global(store, value, Mutability::Var)
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
    fn profiles_have_fixed_companion_and_entry_names() {
        assert_eq!(ProgramKind::QuickJs.companion(), "quickjs.wasm");
        assert_eq!(ProgramKind::Jsc.companion(), "jsc-engine.wasm");
        assert_eq!(ProgramKind::Jsc.run(), "jsc_run");
        assert!(ProgramKind::Jsc.initializers().contains(&"jsc_register"));
    }
}
