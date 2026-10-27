//! Side imports that the side defines itself, bound the way Waffle's `link/relay.ts` does.
//!
//! wasm-ld shared libraries import some of their own exported definitions through `env`
//! or `GOT.func`. The core does not export them, and the side cannot name its own exports
//! before it exists. Each such definition gets one reserved table slot. Its `env` import
//! is a relay function that `call_indirect`s that slot with the exact import type, and its
//! `GOT.func` cell is the slot index. The slots are filled with the side's exports after
//! instantiation, before relocation or constructors run.

use std::collections::HashMap;

use anyhow::{Context, Result, bail, ensure};
use wasm_encoder::{
    CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction, RefType, TableType, TypeSection,
};
use wasmparser::{ExternalKind, Parser, Payload, TypeRef};
use wasmtime::{
    Engine, Extern, ExternType, FuncType, Global, GlobalType, Instance, Module, Mutability, Ref,
    Store, Table, Val, ValType,
};

#[derive(Default)]
pub(super) struct SelfPlan {
    /// The side export bound to each slot, in slot order.
    targets: Vec<String>,
    /// Import name to slot. Aliases of one definition share its slot.
    slots: HashMap<String, u32>,
    relay: Option<Module>,
}

/// Bound slots for one instantiation: the first slot's table index and the relay.
pub(super) struct SelfSlots {
    base: u32,
    relay: Option<Instance>,
}

impl SelfPlan {
    /// The core preempts. Otherwise only a defined side export of the exact type binds.
    pub(super) fn new(engine: &Engine, core: &Module, side: &Module, bytes: &[u8]) -> Result<Self> {
        let defined = defined_functions(bytes)?;
        let mut plan = Self::default();
        let mut types = Vec::new();
        let mut by_index = HashMap::new();
        for import in side.imports() {
            let (module, name) = (import.module(), import.name());
            let expected = match (module, import.ty()) {
                ("env", ExternType::Func(ty)) if core.get_export(name).is_none() => Some(ty),
                ("GOT.func", _) => match core.get_export(name) {
                    Some(ExternType::Func(_)) => continue,
                    Some(_) => bail!("core export GOT.func.{name} must be a function"),
                    None => None,
                },
                _ => continue,
            };
            let Some(ExternType::Func(ty)) = side.get_export(name) else {
                bail!("{module}.{name} requires a core or same-side function export");
            };
            let index = *defined.get(name).with_context(|| {
                format!("{module}.{name} same-side export re-exports an import, not a definition")
            })?;
            if let Some(expected) = expected {
                ensure!(
                    FuncType::eq(&expected, &ty),
                    "env.{name} has an incompatible same-side function signature"
                );
            }
            let slot = *by_index.entry(index).or_insert_with(|| {
                plan.targets.push(name.to_owned());
                types.push(ty);
                plan.targets.len() as u32 - 1
            });
            plan.slots.insert(name.to_owned(), slot);
        }
        if !types.is_empty() {
            plan.relay = Some(Module::new(engine, relay_module(&types)?)?);
        }
        Ok(plan)
    }

    pub(super) fn slot(&self, name: &str) -> Option<u32> {
        self.slots.get(name).copied()
    }

    /// Reserve empty slots at the end of the shared table and instantiate the relay over them.
    pub(super) fn reserve<T>(&self, store: &mut Store<T>, table: Table) -> Result<SelfSlots> {
        let Some(relay) = &self.relay else {
            return Ok(SelfSlots {
                base: 0,
                relay: None,
            });
        };
        let base = table.grow(&mut *store, self.targets.len() as u64, Ref::Func(None))?;
        let base = u32::try_from(base).context("self-bound slots exceed wasm32")?;
        ensure!(
            u64::from(base) + self.targets.len() as u64 <= u64::from(u32::MAX),
            "self-bound slots exceed wasm32"
        );
        let base_global = Global::new(
            &mut *store,
            GlobalType::new(ValType::I32, Mutability::Const),
            Val::I32(base as i32),
        )?;
        let imports = [Extern::Table(table), Extern::Global(base_global)];
        let relay = Instance::new(&mut *store, relay, &imports)?;
        Ok(SelfSlots {
            base,
            relay: Some(relay),
        })
    }

    /// Fill the reserved slots with the side's own definitions.
    pub(super) fn bind<T>(
        &self,
        store: &mut Store<T>,
        table: Table,
        slots: &SelfSlots,
        side: Instance,
    ) -> Result<()> {
        for (slot, name) in self.targets.iter().enumerate() {
            let function = side.get_func(&mut *store, name).with_context(|| {
                format!("same-side definition {name} is not an exported function")
            })?;
            table.set(
                &mut *store,
                u64::from(slots.base) + slot as u64,
                Ref::Func(Some(function)),
            )?;
        }
        Ok(())
    }
}

impl SelfSlots {
    /// The relay function an `env` import of this slot resolves to.
    pub(super) fn relay<T>(&self, store: &mut Store<T>, slot: u32) -> Result<Extern> {
        let relay = self.relay.context("no self-bound relay")?;
        let function = relay
            .get_func(&mut *store, &format!("f{slot}"))
            .context("missing relay function")?;
        Ok(function.into())
    }

    /// The table index a `GOT.func` cell of this slot holds.
    pub(super) fn address(&self, slot: u32) -> u32 {
        self.base + slot
    }
}

/// Exported function names mapped to their function index, for definitions only.
fn defined_functions(bytes: &[u8]) -> Result<HashMap<String, u32>> {
    let mut imported = 0;
    let mut defined = HashMap::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::ImportSection(section) => {
                for import in section {
                    if matches!(import?.ty, TypeRef::Func(_)) {
                        imported += 1;
                    }
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.kind == ExternalKind::Func && export.index >= imported {
                        defined.insert(export.name.to_owned(), export.index);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(defined)
}

/// Function `f{i}` forwards its parameters to `env.table[env.base + i]` with type `i`.
fn relay_module(types: &[FuncType]) -> Result<Vec<u8>> {
    let mut section = TypeSection::new();
    let mut functions = FunctionSection::new();
    let mut exports = ExportSection::new();
    let mut code = CodeSection::new();
    for (index, ty) in types.iter().enumerate() {
        let index = index as u32;
        let params = ty.params().map(encoded).collect::<Result<Vec<_>>>()?;
        let results = ty.results().map(encoded).collect::<Result<Vec<_>>>()?;
        section.ty().function(params.iter().copied(), results);
        functions.function(index);
        exports.export(&format!("f{index}"), ExportKind::Func, index);
        let mut body = Function::new([]);
        for param in 0..params.len() as u32 {
            body.instruction(&Instruction::LocalGet(param));
        }
        body.instruction(&Instruction::GlobalGet(0))
            .instruction(&Instruction::I32Const(index as i32))
            .instruction(&Instruction::I32Add)
            .instruction(&Instruction::CallIndirect {
                type_index: index,
                table_index: 0,
            })
            .instruction(&Instruction::End);
        code.function(&body);
    }
    let mut imports = ImportSection::new();
    imports
        .import(
            "env",
            "table",
            EntityType::Table(TableType {
                element_type: RefType::FUNCREF,
                table64: false,
                minimum: 0,
                maximum: None,
                shared: false,
            }),
        )
        .import(
            "env",
            "base",
            EntityType::Global(wasm_encoder::GlobalType {
                val_type: wasm_encoder::ValType::I32,
                mutable: false,
                shared: false,
            }),
        );
    let mut module = wasm_encoder::Module::new();
    module
        .section(&section)
        .section(&imports)
        .section(&functions)
        .section(&exports)
        .section(&code);
    Ok(module.finish())
}

fn encoded(ty: ValType) -> Result<wasm_encoder::ValType> {
    Ok(match ty {
        ValType::I32 => wasm_encoder::ValType::I32,
        ValType::I64 => wasm_encoder::ValType::I64,
        ValType::F32 => wasm_encoder::ValType::F32,
        ValType::F64 => wasm_encoder::ValType::F64,
        _ => bail!("self-bound function signature uses an unsupported type"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_encoder::ValType as Encoded;

    fn core() -> Vec<u8> {
        let mut tables = wasm_encoder::TableSection::new();
        tables.table(TableType {
            element_type: RefType::FUNCREF,
            table64: false,
            minimum: 1,
            maximum: None,
            shared: false,
        });
        let mut exports = ExportSection::new();
        exports.export("__indirect_function_table", ExportKind::Table, 0);
        let mut module = wasm_encoder::Module::new();
        module.section(&tables).section(&exports);
        module.finish()
    }

    /// Imports `own` (type `own_result`) through env and GOT.func; defines and exports `own`
    /// returning 42 unless `reexport`, in which case `own` re-exports an imported function.
    fn side(own_result: Encoded, reexport: bool) -> Vec<u8> {
        let mut types = TypeSection::new();
        types.ty().function([], [own_result]);
        types.ty().function([], [Encoded::I32]);
        let table = TableType {
            element_type: RefType::FUNCREF,
            table64: false,
            minimum: 0,
            maximum: None,
            shared: false,
        };
        let cell = wasm_encoder::GlobalType {
            val_type: Encoded::I32,
            mutable: true,
            shared: false,
        };
        let mut imports = ImportSection::new();
        imports
            .import("env", "__indirect_function_table", EntityType::Table(table))
            .import("env", "own", EntityType::Function(1))
            .import("GOT.func", "own", EntityType::Global(cell));
        if reexport {
            imports.import("env", "other", EntityType::Function(1));
        }
        let first = if reexport { 2 } else { 1 };
        let mut functions = FunctionSection::new();
        functions.function(0).function(1).function(1);
        let mut exports = ExportSection::new();
        exports
            .export("own", ExportKind::Func, if reexport { 1 } else { first })
            .export("call_own", ExportKind::Func, first + 1)
            .export("own_slot", ExportKind::Func, first + 2);
        let mut code = CodeSection::new();
        let mut own = Function::new([]);
        own.instruction(&match own_result {
            Encoded::I64 => Instruction::I64Const(42),
            _ => Instruction::I32Const(42),
        })
        .instruction(&Instruction::End);
        let mut call_own = Function::new([]);
        call_own
            .instruction(&Instruction::Call(0))
            .instruction(&Instruction::End);
        let mut own_slot = Function::new([]);
        own_slot
            .instruction(&Instruction::GlobalGet(0))
            .instruction(&Instruction::End);
        code.function(&own).function(&call_own).function(&own_slot);
        let mut module = wasm_encoder::Module::new();
        module
            .section(&types)
            .section(&imports)
            .section(&functions)
            .section(&exports)
            .section(&code);
        module.finish()
    }

    #[test]
    fn own_definitions_bind_through_reserved_slots() {
        let engine = Engine::default();
        let core = Module::new(&engine, core()).unwrap();
        let bytes = side(Encoded::I32, false);
        let side = Module::new(&engine, &bytes).unwrap();
        let plan = SelfPlan::new(&engine, &core, &side, &bytes).unwrap();
        let slot = plan.slot("own").unwrap();
        let mut store = Store::new(&engine, ());
        let instance = Instance::new(&mut store, &core, &[]).unwrap();
        let table = instance
            .get_table(&mut store, "__indirect_function_table")
            .unwrap();
        let slots = plan.reserve(&mut store, table).unwrap();
        assert_eq!(slots.address(slot), 1);
        let cell = Global::new(
            &mut store,
            GlobalType::new(ValType::I32, Mutability::Var),
            Val::I32(slots.address(slot) as i32),
        )
        .unwrap();
        let imports = [
            table.into(),
            slots.relay(&mut store, slot).unwrap(),
            cell.into(),
        ];
        let side = Instance::new(&mut store, &side, &imports).unwrap();
        plan.bind(&mut store, table, &slots, side).unwrap();
        let call = side
            .get_typed_func::<(), i32>(&mut store, "call_own")
            .unwrap();
        assert_eq!(call.call(&mut store, ()).unwrap(), 42);
        let address = side
            .get_typed_func::<(), i32>(&mut store, "own_slot")
            .unwrap();
        let address = address.call(&mut store, ()).unwrap() as u64;
        let Some(Ref::Func(Some(entry))) = table.get(&mut store, address) else {
            panic!("bound slot is empty");
        };
        let own = side.get_func(&mut store, "own").unwrap();
        assert_eq!(entry.to_raw(&mut store), own.to_raw(&mut store));
    }

    #[test]
    fn own_definitions_must_exist_match_and_be_defined() {
        let engine = Engine::default();
        let core = Module::new(&engine, core()).unwrap();
        for (bytes, error) in [
            (
                side(Encoded::I64, false),
                "incompatible same-side function signature",
            ),
            (side(Encoded::I32, true), "re-exports an import"),
        ] {
            let side = Module::new(&engine, &bytes).unwrap();
            let message = SelfPlan::new(&engine, &core, &side, &bytes)
                .err()
                .unwrap()
                .to_string();
            assert!(message.contains(error), "{message}");
        }
        let empty = wasm_encoder::Module::new().finish();
        let mut imports = ImportSection::new();
        let mut types = TypeSection::new();
        types.ty().function([], []);
        imports.import("env", "missing", EntityType::Function(0));
        let mut module = wasm_encoder::Module::new();
        module.section(&types).section(&imports);
        let bytes = module.finish();
        let side = Module::new(&engine, &bytes).unwrap();
        let message = SelfPlan::new(&engine, &core, &side, &bytes)
            .err()
            .unwrap()
            .to_string();
        assert!(
            message.contains("requires a core or same-side function export"),
            "{message}"
        );
        assert!(
            SelfPlan::new(
                &engine,
                &core,
                &Module::new(&engine, &empty).unwrap(),
                &empty
            )
            .unwrap()
            .slot("missing")
            .is_none()
        );
    }
}
