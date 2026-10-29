//! Compile nested WebAssembly to checked regions of a host-owned memory.
//!
//! The host contract is documented in `docs/nested-regionizer.md`.

mod admission;
mod operators;
mod rewrite;
mod sections;

use std::fmt;

/// Reserved import namespace. Inputs may not import from this module.
pub const IMPORT_MODULE: &str = "bunwasm_region";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompileErrorKind {
    InvalidInput,
    Unsupported,
    InvalidOutput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompileError {
    pub kind: CompileErrorKind,
    pub offset: Option<usize>,
    pub message: String,
}

impl CompileError {
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            kind: CompileErrorKind::Unsupported,
            offset: None,
            message: message.into(),
        }
    }

    fn validation(kind: CompileErrorKind, error: wasmparser::BinaryReaderError) -> Self {
        Self {
            kind,
            offset: Some(error.offset()),
            message: error.message().to_owned(),
        }
    }
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for CompileError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportName {
    pub module: String,
    pub name: String,
}

/// The original nested memory's limits. These constrain the host region, not the group.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryPlan {
    pub initial_pages: u32,
    pub maximum_pages: Option<u32>,
    pub shared: bool,
    pub original_import: Option<ImportName>,
}

#[derive(Debug)]
pub struct RegionizedModule {
    pub bytes: Vec<u8>,
    pub memory: Option<MemoryPlan>,
}

/// Validate, admit, rewrite, and validate a core WebAssembly module.
///
/// No host engine or current executor is invoked by this function.
pub fn regionize(bytes: &[u8]) -> Result<RegionizedModule, CompileError> {
    let info = admission::scan(bytes)?;
    admission::validate(bytes, CompileErrorKind::InvalidInput)?;
    let memory = info.memory.clone();
    let mut rewriter = rewrite::Regionizer::new(info);
    let bytes = rewriter.encode(bytes)?;
    admission::validate(&bytes, CompileErrorKind::InvalidOutput)?;
    Ok(RegionizedModule { bytes, memory })
}
