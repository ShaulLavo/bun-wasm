//! The JS-visible shape of a validated nested module, read from its original bytes.
// Only the shared-group core builds the records; split builds compile this for its tests.
#![cfg_attr(not(bun_wasm_shared_group), allow(dead_code))]
use super::error;
use crate::data::{NativeError, Record, Val};
use serde::{Deserialize, Serialize};
use wasmparser::{ExternalKind, Parser, Payload, RefType, TypeRef, ValType};

const UNSUPPORTED_REFERENCE: &str = "Unsupported nested reference boundary";

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Import {
    pub(super) module: String,
    pub(super) name: String,
    pub(super) kind: ImportKind,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) enum ImportKind {
    Function {
        params: Vec<String>,
        results: Vec<String>,
    },
    Memory,
    Global(String),
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Export {
    pub(super) name: String,
    pub(super) kind: String,
    pub(super) index: u32,
    pub(super) element: Option<String>,
    pub(super) ty: Option<String>,
    pub(super) mutable: Option<bool>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Limits {
    pub(super) initial_pages: u32,
    pub(super) maximum_pages: Option<u32>,
}
/// A compiled module's JS-visible shape. The directory carries it opaquely between members
/// of one group, which already share every byte, so it needs no second validation.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Description {
    pub(super) memory: Limits,
    pub(super) imports: Vec<Import>,
    pub(super) exports: Vec<Export>,
}

pub(super) fn type_name(ty: ValType) -> Result<String, NativeError> {
    Ok(match ty {
        ValType::I32 => "i32",
        ValType::I64 => "i64",
        ValType::F32 => "f32",
        ValType::F64 => "f64",
        ValType::V128 => "v128",
        ValType::Ref(_) => return Err(error(UNSUPPORTED_REFERENCE)),
    }
    .to_owned())
}

pub(super) fn strings(types: &[String]) -> Val {
    Val::Array(
        types
            .iter()
            .map(|value| Val::from(value.as_str()))
            .collect(),
    )
}

#[derive(Clone)]
struct GlobalShape {
    ty: String,
    mutable: bool,
}

/// What the index spaces declare. A shape that JS cannot represent is None, and only refuses
/// the module when it is actually exported.
#[derive(Default)]
struct Declared {
    types: Vec<wasmparser::FuncType>,
    tables: Vec<Option<String>>,
    globals: Vec<Option<GlobalShape>>,
}

impl Declared {
    fn add_types(&mut self, section: wasmparser::TypeSectionReader<'_>) -> Result<(), NativeError> {
        for ty in section.into_iter_err_on_gc_types() {
            self.types.push(ty.map_err(error)?);
        }
        Ok(())
    }

    fn add_imports(
        &mut self,
        section: wasmparser::ImportSectionReader<'_>,
        imports: &mut Vec<Import>,
    ) -> Result<(), NativeError> {
        for item in section {
            let import = describe_import(item.map_err(error)?, &self.types)?;
            if let ImportKind::Global(ty) = &import.kind {
                let ty = ty.clone();
                self.globals.push(Some(GlobalShape { ty, mutable: false }));
            }
            imports.push(import);
        }
        Ok(())
    }

    fn add_tables(
        &mut self,
        section: wasmparser::TableSectionReader<'_>,
    ) -> Result<(), NativeError> {
        for table in section {
            let element = table.map_err(error)?.ty.element_type;
            self.tables
                .push((element == RefType::FUNCREF).then(|| "funcref".to_owned()));
        }
        Ok(())
    }

    fn add_globals(
        &mut self,
        section: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), NativeError> {
        for global in section {
            let ty = global.map_err(error)?.ty;
            let shape = type_name(ty.content_type).ok().map(|name| GlobalShape {
                ty: name,
                mutable: ty.mutable,
            });
            self.globals.push(shape);
        }
        Ok(())
    }

    fn add_exports(
        &self,
        section: wasmparser::ExportSectionReader<'_>,
        exports: &mut Vec<Export>,
    ) -> Result<(), NativeError> {
        for item in section {
            exports.push(self.describe_export(item.map_err(error)?)?);
        }
        Ok(())
    }

    fn describe_export(&self, item: wasmparser::Export<'_>) -> Result<Export, NativeError> {
        let index = item.index as usize;
        let mut export = Export {
            name: item.name.to_owned(),
            kind: String::new(),
            index: item.index,
            element: None,
            ty: None,
            mutable: None,
        };
        let unsupported = || error(UNSUPPORTED_REFERENCE);
        export.kind = match item.kind {
            ExternalKind::Func => "function",
            ExternalKind::Memory => "memory",
            ExternalKind::Table => {
                let element = self.tables.get(index).cloned().flatten();
                export.element = Some(element.ok_or_else(unsupported)?);
                "table"
            }
            ExternalKind::Global => {
                let shape = self.globals.get(index).cloned().flatten();
                let shape = shape.ok_or_else(unsupported)?;
                export.ty = Some(shape.ty);
                export.mutable = Some(shape.mutable);
                "global"
            }
            ExternalKind::Tag => return Err(unsupported()),
        }
        .to_owned();
        Ok(export)
    }
}

fn describe_import(
    item: wasmparser::Import<'_>,
    types: &[wasmparser::FuncType],
) -> Result<Import, NativeError> {
    let kind = match item.ty {
        TypeRef::Memory(_) => ImportKind::Memory,
        TypeRef::Func(index) => function_import(index, types)?,
        TypeRef::Global(global) if !global.mutable => {
            ImportKind::Global(type_name(global.content_type)?)
        }
        _ => return Err(error("Unsupported nested import kind")),
    };
    Ok(Import {
        module: item.module.to_owned(),
        name: item.name.to_owned(),
        kind,
    })
}

fn type_names(types: &[ValType]) -> Result<Vec<String>, NativeError> {
    types.iter().copied().map(type_name).collect()
}

fn function_import(index: u32, types: &[wasmparser::FuncType]) -> Result<ImportKind, NativeError> {
    let ty = types
        .get(index as usize)
        .ok_or_else(|| error("invalid nested function type"))?;
    Ok(ImportKind::Function {
        params: type_names(ty.params())?,
        results: type_names(ty.results())?,
    })
}

pub(super) fn describe(bytes: &[u8], memory: Limits) -> Result<Description, NativeError> {
    let mut declared = Declared::default();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(error)? {
            Payload::TypeSection(section) => declared.add_types(section)?,
            Payload::ImportSection(section) => declared.add_imports(section, &mut imports)?,
            Payload::TableSection(section) => declared.add_tables(section)?,
            Payload::GlobalSection(section) => declared.add_globals(section)?,
            Payload::ExportSection(section) => declared.add_exports(section, &mut exports)?,
            _ => {}
        }
    }
    Ok(Description {
        memory,
        imports,
        exports,
    })
}

fn import_record(import: &Import) -> Val {
    let base = Record::new()
        .set("module", import.module.as_str())
        .set("name", import.name.as_str());
    match &import.kind {
        ImportKind::Function { params, results } => base
            .set("kind", "function")
            .set("params", strings(params))
            .set("results", strings(results))
            .into(),
        ImportKind::Memory => base.set("kind", "memory").into(),
        ImportKind::Global(ty) => base
            .set("kind", "global")
            .set("type", ty.as_str())
            .set("mutable", false)
            .into(),
    }
}

fn export_record(export: &Export) -> Val {
    let mut record = Record::new()
        .set("name", export.name.as_str())
        .set("kind", export.kind.as_str())
        .set("index", export.index);
    if let Some(element) = &export.element {
        record = record.set("element", element.as_str());
    }
    if let Some(ty) = &export.ty {
        record = record.set("type", ty.as_str());
    }
    if let Some(mutable) = export.mutable {
        record = record.set("mutable", mutable);
    }
    record.into()
}

pub(super) fn module_record(id: u32, description: &Description) -> Val {
    let imports: Vec<_> = description.imports.iter().map(import_record).collect();
    let exports: Vec<_> = description.exports.iter().map(export_record).collect();
    Record::new()
        .set("id", id)
        .set("backend", "nested")
        .set("imports", imports)
        .set("exports", exports)
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits {
        initial_pages: 1,
        maximum_pages: Some(2),
    };

    fn module(sections: &[(u8, &[u8])]) -> Vec<u8> {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        for (id, body) in sections {
            bytes.push(*id);
            bytes.push(body.len() as u8);
            bytes.extend_from_slice(body);
        }
        bytes
    }

    fn message(result: Result<Description, NativeError>) -> String {
        match result {
            Ok(_) => panic!("expected a refused module"),
            Err(error) => error.message,
        }
    }

    #[test]
    fn funcref_tables_report_their_index_and_element() {
        let bytes = module(&[
            (4, &[1, 0x70, 0, 1]),
            (7, &[2, 1, b't', 1, 0, 1, b'u', 1, 0]),
        ]);
        let description = describe(&bytes, LIMITS).ok().unwrap();
        assert_eq!(description.exports.len(), 2);
        for export in &description.exports {
            assert_eq!(export.kind, "table");
            assert_eq!(export.index, 0);
            assert_eq!(export.element.as_deref(), Some("funcref"));
        }
    }

    #[test]
    fn an_unexported_externref_table_is_not_a_refusal() {
        let bytes = module(&[(4, &[1, 0x6f, 0, 1])]);
        assert!(describe(&bytes, LIMITS).is_ok());
    }

    #[test]
    fn exported_reference_tables_and_globals_are_refused() {
        let table = module(&[(4, &[1, 0x6f, 0, 1]), (7, &[1, 1, b't', 1, 0])]);
        assert_eq!(message(describe(&table, LIMITS)), UNSUPPORTED_REFERENCE);
        let global = module(&[
            (6, &[1, 0x70, 1, 0xd0, 0x70, 0x0b]),
            (7, &[1, 1, b'g', 3, 0]),
        ]);
        assert_eq!(message(describe(&global, LIMITS)), UNSUPPORTED_REFERENCE);
    }

    #[test]
    fn global_exports_index_imports_before_definitions() {
        let bytes = module(&[
            (2, &[1, 1, b'e', 1, b'g', 3, 0x7e, 0]),
            (6, &[1, 0x7f, 1, 0x41, 7, 0x0b]),
            (7, &[2, 1, b'i', 3, 0, 1, b'd', 3, 1]),
        ]);
        let description = describe(&bytes, LIMITS).ok().unwrap();
        let imported = &description.exports[0];
        assert_eq!(
            (imported.index, imported.ty.as_deref(), imported.mutable),
            (0, Some("i64"), Some(false))
        );
        let defined = &description.exports[1];
        assert_eq!(
            (defined.index, defined.ty.as_deref(), defined.mutable),
            (1, Some("i32"), Some(true))
        );
    }
}
