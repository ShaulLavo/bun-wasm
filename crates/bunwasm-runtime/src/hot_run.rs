//! Strict, data-only hot snapshots. The JS session owns records and diagnostics.
use crate::data::{NativeError, Record, Val};
use crate::modules::{self, Format, PositionMap};
use crate::{State, sourcemap, transpiler::Loader};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn identity_part(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

impl State {
    pub(crate) fn hot_digest(&self, path: &str) -> Result<String, NativeError> {
        let bytes = std::fs::read(path)
            .map_err(|error| crate::natives::io_error(error, "open", Some(path)))?;
        Ok(digest(&bytes))
    }

    pub(crate) fn prepare_hot(&self, generation: u32, name: &str) -> Result<Val, NativeError> {
        if generation == 0 {
            return Err(NativeError::type_error("Invalid hot generation"));
        }
        if crate::resolve::builtin_name(name).is_some() {
            return Ok(Record::new()
                .set("kind", "builtin")
                .set("name", name)
                .into());
        }
        let path = self.module_path(name);
        let bytes = std::fs::read(&path)
            .map_err(|error| crate::natives::io_error(error, "open", Some(&path)))?;
        let digest = digest(&bytes);
        let original = String::from_utf8_lossy(&bytes);
        let identity = format!(
            "bunwasm:hot:{generation}:{}#module={}",
            identity_part(&path),
            identity_part(name)
        );
        let (code, format, map) = self.hot_source(name, &path, &original).map_err(|error| {
            error
                .prop("__bunwasmHotPath", path.clone())
                .prop("__bunwasmHotDigest", digest.clone())
        })?;
        if format != Format::Esm {
            return Err(NativeError::type_error(format!(
                "--hot requires an ESM graph; {} module '{path}' is not supported",
                format.name()
            )));
        }
        let prologue = modules::esm_prologue(&code);
        let shift = prologue.chars().count() as u32;
        let source = format!("{prologue}{code}");
        // Resolve with the physical name, not the diagnostic identity. Registering tokens
        // here also keeps static import attributes on the process resolver's existing route.
        let record = self.transpiler.register(&source, &path).map_err(|error| {
            modules::module_compile_error(error, &original)
                .prop("__bunwasmHotPath", path.clone())
                .prop("__bunwasmHotDigest", digest.clone())
        })?;
        let diagnostic = Record::new()
            .set("path", path.clone())
            .set("original", original.as_ref())
            .set("record", record.mappings)
            .set("map", map)
            .set("line1Shift", shift)
            .set("lineOffset", 0u32);
        Ok(Record::new()
            .set("kind", "esm")
            .set("path", path)
            .set("digest", digest)
            .set("identity", identity)
            .set("code", record.code)
            .set("diagnostic", diagnostic)
            .into())
    }

    fn hot_source(
        &self,
        name: &str,
        path: &str,
        raw: &str,
    ) -> Result<(String, Format, Option<String>), NativeError> {
        if name != path
            || matches!(Loader::from_path(path), Loader::Json | Loader::Text)
                && !path.ends_with(".html")
        {
            let value = if name != path || Loader::from_path(path) == Loader::Text {
                serde_json::Value::String(raw.to_owned())
            } else {
                serde_json::from_str(raw)
                    .map_err(|error| NativeError::syntax_error(format!("{path}: {error}")))?
            };
            return Ok((format!("export default {value};"), Format::Esm, None));
        }
        if path.ends_with(".html") {
            return Err(NativeError::type_error(
                "--hot does not support HTMLBundle entries; import HTML with type: 'text'",
            ));
        }
        let out = self.prepare_javascript(raw, path, Loader::from_path(path))?;
        let format = self.detect_format(path, &out.code, out.module_kind);
        Ok((modules::strip_shebang(&out.code), format, out.mappings))
    }
}

pub(crate) fn map_position(
    record: Option<&str>,
    map: Option<&str>,
    shift: u32,
    offset: u32,
    line: u32,
    column: u32,
) -> Val {
    let position = PositionMap {
        record: record
            .filter(|text| !text.is_empty())
            .map(sourcemap::SourceMap::new),
        map: map
            .filter(|text| !text.is_empty())
            .map(sourcemap::SourceMap::new),
        line1_shift: shift,
        line_offset: offset,
        original: None,
    };
    let (line, column) = position.original_position(line, column);
    Val::Array(vec![line.into(), column.into()])
}
