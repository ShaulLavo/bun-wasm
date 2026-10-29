use wasmparser::{DataKind, Import, Operator as O, Parser, Payload, TypeRef, WasmFeatures};

use crate::{CompileError, CompileErrorKind, IMPORT_MODULE, ImportName, MemoryPlan};

#[derive(Clone, Copy)]
pub(crate) enum Offset {
    Const(i32),
    Global(u32),
}

#[derive(Clone, Copy)]
pub(crate) struct ActiveData {
    pub segment: u32,
    pub offset: Offset,
    pub length: u32,
}

#[derive(Default)]
pub(crate) struct Info {
    pub params: Vec<u32>,
    pub defined: Vec<u32>,
    pub imported_funcs: u32,
    pub imported_globals: u32,
    pub defined_globals: u32,
    pub memory: Option<MemoryPlan>,
    pub active: Vec<ActiveData>,
    pub start: Option<u32>,
    pub segments: u32,
    pub sections: Vec<wasm_encoder::SectionId>,
}

pub(crate) fn features() -> WasmFeatures {
    WasmFeatures::WASM2 | WasmFeatures::THREADS | WasmFeatures::TAIL_CALL
}

pub(crate) fn validate(bytes: &[u8], kind: CompileErrorKind) -> Result<(), CompileError> {
    wasmparser::Validator::new_with_features(features())
        .validate_all(bytes)
        .map(|_| ())
        .map_err(|error| CompileError::validation(kind, error))
}

pub(crate) fn scan(bytes: &[u8]) -> Result<Info, CompileError> {
    let mut info = Info::default();
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(input_error)?;
        scan_payload(&mut info, payload)?;
    }
    Ok(info)
}

fn scan_payload(info: &mut Info, payload: Payload<'_>) -> Result<(), CompileError> {
    if let Some((id, _)) = payload.as_section() {
        record_section(info, id)?;
    }
    match payload {
        Payload::Version {
            encoding: wasmparser::Encoding::Module,
            ..
        }
        | Payload::End(_) => (),
        Payload::TypeSection(section) => scan_types(info, section)?,
        Payload::ImportSection(section) => scan_imports(info, section)?,
        Payload::FunctionSection(section) => {
            info.defined = section
                .into_iter()
                .collect::<Result<_, _>>()
                .map_err(input_error)?;
        }
        Payload::MemorySection(section) => scan_memories(info, section)?,
        Payload::GlobalSection(section) => info.defined_globals = section.count(),
        Payload::StartSection { func, .. } => info.start = Some(func),
        Payload::DataSection(section) => scan_data(info, section)?,
        Payload::CodeSectionEntry(body) => check_operators(body)?,
        Payload::TagSection(_) => return Err(CompileError::unsupported("exception handling")),
        Payload::ExportSection(_)
        | Payload::TableSection(_)
        | Payload::ElementSection(_)
        | Payload::DataCountSection { .. }
        | Payload::CodeSectionStart { .. }
        | Payload::CustomSection(_) => (),
        _ => {
            return Err(CompileError::unsupported(
                "unsupported section or module encoding",
            ));
        }
    }
    Ok(())
}

fn record_section(info: &mut Info, id: u8) -> Result<(), CompileError> {
    use wasm_encoder::SectionId::*;
    let section = match id {
        0 => return Ok(()),
        1 => Type,
        2 => Import,
        3 => Function,
        4 => Table,
        5 => Memory,
        6 => Global,
        7 => Export,
        8 => Start,
        9 => Element,
        10 => Code,
        11 => Data,
        12 => DataCount,
        _ => return Err(CompileError::unsupported(format!("section {id}"))),
    };
    info.sections.push(section);
    Ok(())
}

fn scan_types(
    info: &mut Info,
    section: wasmparser::TypeSectionReader<'_>,
) -> Result<(), CompileError> {
    for ty in section.into_iter_err_on_gc_types() {
        info.params
            .push(ty.map_err(input_error)?.params().len() as u32);
    }
    Ok(())
}

fn scan_imports(
    info: &mut Info,
    section: wasmparser::ImportSectionReader<'_>,
) -> Result<(), CompileError> {
    for import in section {
        scan_import(info, import.map_err(input_error)?)?;
    }
    Ok(())
}

fn scan_import(info: &mut Info, import: Import<'_>) -> Result<(), CompileError> {
    if import.module == IMPORT_MODULE {
        return Err(CompileError::unsupported(
            "reserved bunwasm_region import namespace",
        ));
    }
    match import.ty {
        TypeRef::Func(_) => info.imported_funcs += 1,
        TypeRef::Global(ty)
            if !ty.mutable
                && matches!(
                    ty.content_type,
                    wasmparser::ValType::I32
                        | wasmparser::ValType::I64
                        | wasmparser::ValType::F32
                        | wasmparser::ValType::F64
                ) =>
        {
            info.imported_globals += 1
        }
        TypeRef::Global(_) => {
            return Err(CompileError::unsupported(
                "mutable or reference global import",
            ));
        }
        TypeRef::Memory(ty) => add_memory(
            info,
            ty,
            Some(ImportName {
                module: import.module.to_owned(),
                name: import.name.to_owned(),
            }),
        )?,
        TypeRef::Table(_) => return Err(CompileError::unsupported("imported table")),
        TypeRef::Tag(_) => return Err(CompileError::unsupported("exception handling import")),
    }
    Ok(())
}

fn add_memory(
    info: &mut Info,
    ty: wasmparser::MemoryType,
    original_import: Option<ImportName>,
) -> Result<(), CompileError> {
    if info.memory.is_some() {
        return Err(CompileError::unsupported("multi-memory"));
    }
    if ty.memory64 || ty.page_size_log2.is_some() {
        return Err(CompileError::unsupported("memory64 or custom page size"));
    }
    let initial_pages =
        u32::try_from(ty.initial).map_err(|_| CompileError::unsupported("initial memory limit"))?;
    let maximum_pages = ty
        .maximum
        .map(u32::try_from)
        .transpose()
        .map_err(|_| CompileError::unsupported("maximum memory limit"))?;
    info.memory = Some(MemoryPlan {
        initial_pages,
        maximum_pages,
        shared: ty.shared,
        original_import,
    });
    Ok(())
}

fn scan_data(
    info: &mut Info,
    section: wasmparser::DataSectionReader<'_>,
) -> Result<(), CompileError> {
    info.segments = section.count();
    for (index, data) in section.into_iter().enumerate() {
        let data = data.map_err(input_error)?;
        let DataKind::Active {
            memory_index,
            offset_expr,
        } = data.kind
        else {
            continue;
        };
        if memory_index != 0 {
            return Err(CompileError::unsupported(
                "active segment on another memory",
            ));
        }
        let offset = data_offset(offset_expr)?;
        info.active.push(ActiveData {
            segment: index as u32,
            offset,
            length: data.data.len() as u32,
        });
    }
    Ok(())
}

fn data_offset(expr: wasmparser::ConstExpr<'_>) -> Result<Offset, CompileError> {
    let mut reader = expr.get_operators_reader();
    let first = reader.read().map_err(input_error)?;
    let end = reader.read().map_err(input_error)?;
    if !matches!(end, O::End) || !reader.eof() {
        return Err(CompileError::unsupported(
            "non-constant data segment offset",
        ));
    }
    match first {
        O::I32Const { value } => Ok(Offset::Const(value)),
        O::GlobalGet { global_index } => Ok(Offset::Global(global_index)),
        _ => Err(CompileError::unsupported(
            "data offset must be i32.const or global.get",
        )),
    }
}

fn check_operators(body: wasmparser::FunctionBody<'_>) -> Result<(), CompileError> {
    let mut reader = body.get_operators_reader().map_err(input_error)?;
    while !reader.eof() {
        let at = reader.original_position();
        let op = reader.read().map_err(input_error)?;
        crate::operators::admit(&op).map_err(|mut error| {
            error.offset = Some(at);
            error
        })?;
    }
    Ok(())
}

fn input_error(error: wasmparser::BinaryReaderError) -> CompileError {
    CompileError::validation(CompileErrorKind::InvalidInput, error)
}

fn scan_memories(
    info: &mut Info,
    section: wasmparser::MemorySectionReader<'_>,
) -> Result<(), CompileError> {
    for memory in section {
        add_memory(info, memory.map_err(input_error)?, None)?;
    }
    Ok(())
}
