use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use wasmparser::{Dylink0Subsection, KnownCustom, MemInfo, Parser, Payload};
use wasmtime::{
    Engine, Extern, Global, GlobalType, Instance, Linker, Module, Mutability, Ref, Store, Val,
    ValType,
};

use crate::Host;

#[derive(Default)]
pub struct Programs(Vec<Program>);

struct Program {
    core: Module,
    library: Module,
    layout: MemInfo,
}

impl Programs {
    pub fn load(&mut self, engine: &Engine, path: &Path) -> Result<Module> {
        let core = Module::from_file(engine, path)
            .with_context(|| format!("loading {}", path.display()))?;
        if core.get_export("bun_core_bind_engine").is_none() {
            return Ok(core);
        }
        let path = path.with_file_name("quickjs.wasm");
        let bytes = std::fs::read(&path)
            .with_context(|| format!("loading paired QuickJS {}", path.display()))?;
        let layout = layout(&bytes)?;
        let library = Module::new(engine, bytes)?;
        self.0.push(Program {
            core: core.clone(),
            library,
            layout,
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

fn layout(bytes: &[u8]) -> Result<MemInfo> {
    let mut info = None;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::StartSection { .. } => bail!("QuickJS must use explicit initialization"),
            Payload::CustomSection(section) => read_layout(section.as_known(), &mut info)?,
            _ => {}
        }
    }
    let info = info.context("QuickJS has no dylink.0 memory layout")?;
    ensure!(
        info.memory_alignment <= 31 && info.table_alignment <= 31,
        "QuickJS alignment exceeds wasm32"
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
            ensure!(info.replace(layout).is_none(), "duplicate QuickJS layout");
        }
        Dylink0Subsection::Needed(names) if names.is_empty() => {}
        _ => bail!("unsupported QuickJS dylink subsection"),
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
        for name in [
            "quickjs_initialize_memory",
            "quickjs_apply_data_relocs",
            "quickjs_call_ctors",
            "quickjs_register",
        ] {
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
