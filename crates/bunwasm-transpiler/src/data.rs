//! Bun's data parsers with an engine-independent, identity-preserving result.
use std::collections::HashMap;

use bun_alloc::Arena;
use bun_ast::{Expr, ExprData, Source};
use serde_json::{Value, json};

#[derive(Debug)]
pub enum Error {
    Syntax(String),
    Range(String),
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::Syntax(message)
    }
}
impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::Syntax(message.into())
    }
}

pub fn parse(source: &[u8], format: &str) -> Result<String, Error> {
    check_depth(source, format)?;
    let arena = Arena::new();
    let mut ast = bun_ast::ASTMemoryAllocator::borrowing(&arena);
    let _scope = ast.enter();
    let mut log = bun_ast::Log::init();
    let path = format!("input.{}", format.to_ascii_lowercase());
    let source = Source::init_path_string(path.as_bytes(), source);
    let parsed = match format {
        "TOML" => bun_parsers::toml::TOML::parse(&source, &mut log, &arena, false)
            .map_err(|e| matches!(e, bun_parsers::Error::StackOverflow)),
        "YAML" => bun_parsers::yaml::YAML::parse(
            &source,
            &mut log,
            &arena,
            bun_parsers::yaml::CyclicAliases::Allow,
        )
        .map_err(|e| matches!(e, bun_parsers::yaml::YamlParseError::StackOverflow)),
        "JSON5" => bun_parsers::json5::JSON5Parser::parse(&source, &mut log, &arena)
            .map_err(|e| matches!(e, bun_parsers::json5::ExternalError::StackOverflow)),
        "JSONC" if source.contents.is_empty() => {
            return Err(Error::Syntax(
                "JSONC Parse error: Unexpected end of input".into(),
            ));
        }
        "JSONC" => bun_parsers::json::parse_jsonc_into_arena(&source, &mut log, &arena)
            .map_err(|e| matches!(e, bun_parsers::Error::StackOverflow)),
        "JSON" => bun_parsers::json::parse_json_into_arena(&source, &mut log, &arena)
            .map_err(|e| matches!(e, bun_parsers::Error::StackOverflow)),
        _ => return Err(Error::Syntax(format!("Unknown data format: {format}"))),
    };
    let root = parsed
        .and_then(|root| {
            if matches!(format, "JSON" | "JSONC") {
                return bun_parsers::json::materialize(&root, &source, &mut log, &arena)
                    .map_err(|e| matches!(e, bun_parsers::Error::StackOverflow));
            }
            Ok(root)
        })
        .map_err(|range| {
            let msg = log
                .msgs
                .iter()
                .find(|m| m.kind == bun_ast::Kind::Err)
                .or_else(|| log.msgs.first());
            let text = msg
                .map(|m| String::from_utf8_lossy(&m.data.text).into_owned())
                .unwrap_or_else(|| format!("Unable to parse {format} string"));
            let message = format!("{format} Parse error: {text}");
            if range {
                Error::Range(message)
            } else {
                Error::Syntax(message)
            }
        })?;
    let mut graph = Graph {
        yaml_source: (format == "YAML").then_some(source.contents()),
        ..Graph::default()
    };
    let root = graph.value(root)?;
    Ok(json!({"root": root, "nodes": graph.nodes}).to_string())
}

#[derive(Default)]
struct Graph<'a> {
    seen: HashMap<usize, usize>,
    nodes: Vec<Value>,
    pending: Vec<(Expr, usize)>,
    depth: usize,
    yaml_source: Option<&'a [u8]>,
    yaml_aliases: Option<HashMap<usize, &'a str>>,
}

impl Graph<'_> {
    fn value(&mut self, expr: Expr) -> Result<Value, Error> {
        let root = self.encode(expr)?;
        while let Some((expr, depth)) = self.pending.pop() {
            self.depth = depth;
            self.fill(expr)?;
        }
        Ok(root)
    }

    fn reference(&mut self, ptr: usize, expr: Expr) -> Value {
        if let Some(index) = self.seen.get(&ptr) {
            return json!([1, index]);
        }
        let index = self.nodes.len();
        self.seen.insert(ptr, index);
        self.nodes.push(Value::Null);
        self.pending.push((expr, self.depth + 1));
        json!([1, index])
    }

    fn encode(&mut self, expr: Expr) -> Result<Value, Error> {
        if self.depth > 4096 {
            return Err(Error::Range("Maximum call stack size exceeded".into()));
        }
        match expr.data {
            ExprData::EArray(a) => Ok(self.reference(a.as_ptr() as usize, expr)),
            ExprData::EObject(o) => Ok(self.reference(o.as_ptr() as usize, expr)),
            ExprData::EString(s) => {
                let text = string(s.get());
                Ok(match s.toml_datetime {
                    Some(kind) => json!([3, String::from_utf8_lossy(kind.temporal_class()), text]),
                    None if s.is_utf16 => json!([5, s.slice16()]),
                    None if std::str::from_utf8(s.slice8()).is_err() => {
                        json!([5, wtf8(s.slice8())])
                    }
                    None => json!([0, text]),
                })
            }
            ExprData::ENumber(n) => {
                let text = format_number(n.value());
                if let Some(raw) = self.yaml_raw_number(expr.loc.start) {
                    return Ok(json!([4, text, raw]));
                }
                Ok(json!([4, text]))
            }
            ExprData::EBoolean(b) | ExprData::EBranchBoolean(b) => Ok(json!([0, b.value])),
            ExprData::ENull(_) => Ok(json!([0, null])),
            ExprData::EUndefined(_) => Ok(json!([6])),
            ExprData::EBigInt(b) => Ok(json!([2, String::from_utf8_lossy(&b.value)])),
            _ => Err("Cannot convert parsed value to JS".into()),
        }
    }

    fn fill(&mut self, expr: Expr) -> Result<(), Error> {
        let (ptr, node) = match expr.data {
            ExprData::EArray(a) => {
                let items = a
                    .slice()
                    .iter()
                    .map(|e| self.encode(*e))
                    .collect::<Result<Vec<_>, _>>()?;
                (a.as_ptr() as usize, json!(["array", items]))
            }
            ExprData::EObject(o) => {
                let entries = o
                    .properties
                    .iter()
                    .map(|p| self.property(p))
                    .collect::<Result<Vec<_>, _>>()?;
                (o.as_ptr() as usize, json!(["object", entries]))
            }
            _ => unreachable!("only collections enter pending"),
        };
        self.nodes[self.seen[&ptr]] = node;
        Ok(())
    }

    fn property(&mut self, prop: &bun_ast::G::Property) -> Result<Value, Error> {
        let key = self.encode(prop.key.ok_or("Parsed property has no key")?)?;
        Ok(json!([
            key,
            self.encode(prop.value.ok_or("Parsed property has no value")?)?
        ]))
    }

    fn yaml_raw_number(&mut self, start: i32) -> Option<&str> {
        let bytes = self.yaml_source?;
        let start = usize::try_from(start).ok()?;
        let rest = bytes.get(start..)?;
        if rest.first() != Some(&b'*') {
            return yaml_plain_number(rest);
        }
        let aliases = self
            .yaml_aliases
            .get_or_insert_with(|| index_yaml_alias_scalars(bytes));
        aliases.get(&start).copied()
    }
}

fn format_number(n: f64) -> String {
    if !n.is_infinite() {
        return n.to_string();
    }
    if n < 0.0 {
        "-Infinity".into()
    } else {
        "Infinity".into()
    }
}

fn yaml_plain_number(rest: &[u8]) -> Option<&str> {
    let len = rest
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-' | b'_'))
        .count();
    if len == 0 {
        return None;
    }
    std::str::from_utf8(&rest[..len]).ok()
}

fn index_yaml_alias_scalars(source: &[u8]) -> HashMap<usize, &str> {
    use bun_parsers::yaml::{SourceTokenKind, YAML};
    let Ok(tokens) = YAML::parse_as_written(source, |_, tokens| tokens.to_vec()) else {
        return HashMap::new();
    };
    let mut anchors: HashMap<&[u8], &str> = HashMap::new();
    let mut aliases = HashMap::new();
    for (idx, tok) in tokens.iter().enumerate() {
        let Some(name) = source.get(tok.start as usize + 1..tok.end as usize) else {
            continue;
        };
        if tok.kind == SourceTokenKind::Anchor {
            match anchor_scalar_value(source, &tokens[idx + 1..], &anchors) {
                Some(raw) => {
                    anchors.insert(name, raw);
                }
                None => {
                    anchors.remove(name);
                }
            }
            continue;
        }
        if tok.kind == SourceTokenKind::Alias
            && let Some(&raw) = anchors.get(name)
        {
            aliases.insert(tok.start as usize, raw);
        }
    }
    aliases
}

fn anchor_scalar_value<'a>(
    source: &'a [u8],
    rest: &[bun_parsers::yaml::SourceToken],
    anchors: &HashMap<&'a [u8], &'a str>,
) -> Option<&'a str> {
    use bun_parsers::yaml::SourceTokenKind;
    let target = rest
        .iter()
        .find(|tok| !matches!(tok.kind, SourceTokenKind::Tag | SourceTokenKind::Comment))?;
    match target.kind {
        SourceTokenKind::Scalar => {
            let raw = source.get(target.start as usize..target.end as usize)?;
            let text = std::str::from_utf8(raw).ok()?.trim();
            (yaml_plain_number(text.as_bytes()) == Some(text)).then_some(text)
        }
        SourceTokenKind::Alias => {
            let name = source.get(target.start as usize + 1..target.end as usize)?;
            anchors.get(name).copied()
        }
        _ => None,
    }
}

fn string(s: &bun_ast::E::String) -> String {
    if s.is_utf16 {
        return String::from_utf16_lossy(s.slice16());
    }
    let mut bytes = s.slice8().to_vec();
    let mut next = s.next;
    while let Some(part) = next {
        bytes.extend_from_slice(part.slice8());
        next = part.next;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

// JSON strings may contain escaped lone surrogates, stored as WTF-8 by Bun.
fn wtf8(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let first = bytes[i];
        let len = if first < 0x80 {
            1
        } else if first < 0xe0 {
            2
        } else if first < 0xf0 {
            3
        } else {
            4
        };
        let mut cp = (first
            & match len {
                1 => 0x7f,
                2 => 0x1f,
                3 => 0x0f,
                _ => 0x07,
            }) as u32;
        if len == 1 {
            cp = first as u32;
        }
        for &b in bytes.get(i + 1..i + len).unwrap_or_default() {
            cp = (cp << 6) | (b & 0x3f) as u32;
        }
        if cp <= 0xffff {
            out.push(cp as u16);
        } else {
            out.push(0xd800 + ((cp - 0x10000) >> 10) as u16);
            out.push(0xdc00 + ((cp - 0x10000) & 0x3ff) as u16);
        }
        i += len;
    }
    out
}

// Wasm engines have a call-stack limit independent of the linear-memory stack
// Bun's StackCheck measures. Bound recursive parser input before entering it.
fn check_depth(source: &[u8], format: &str) -> Result<(), Error> {
    let mut depth = 0usize;
    let mut i = 0;
    while i < source.len() {
        let c = source[i];
        i += 1;
        if c == b'"' || c == b'\'' {
            i = string_end(source, i - 1, format);
            continue;
        }
        if c == b'#' && matches!(format, "YAML" | "TOML") {
            i += source[i..]
                .iter()
                .position(|&b| b == b'\n')
                .unwrap_or(source.len() - i);
            continue;
        }
        if c == b'/' && source.get(i) == Some(&b'/') {
            i += source[i..]
                .iter()
                .position(|&b| b == b'\n')
                .unwrap_or(source.len() - i);
            continue;
        }
        if c == b'/' && source.get(i) == Some(&b'*') {
            i += source[i..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map(|n| n + 2)
                .unwrap_or(source.len() - i);
            continue;
        }
        if matches!(c, b'[' | b'{') {
            depth += 1;
        }
        if matches!(c, b']' | b'}') {
            depth = depth.saturating_sub(1);
        }
        if depth > 256 {
            return Err(Error::Range(format!(
                "{format} Parse error: Document is too deeply nested"
            )));
        }
    }
    Ok(())
}

fn string_end(source: &[u8], start: usize, format: &str) -> usize {
    let quote = source[start];
    let triple = format == "TOML" && source.get(start..start + 3) == Some(&[quote; 3]);
    let width = if triple { 3 } else { 1 };
    let escapes = quote == b'"' || !matches!(format, "YAML" | "TOML");
    let mut i = start + width;
    while i < source.len() {
        if escapes && source[i] == b'\\' {
            i = (i + 2).min(source.len());
            continue;
        }
        if source
            .get(i..i + width)
            .is_some_and(|bytes| bytes.iter().all(|&b| b == quote))
        {
            return i + width;
        }
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::parse;
    use serde_json::Value;

    fn raw_catalog_entry(yaml: &str, key: &str) -> String {
        let graph: Value = serde_json::from_str(&parse(yaml.as_bytes(), "YAML").unwrap()).unwrap();
        let nodes = graph["nodes"].as_array().unwrap();
        let root_idx = graph["root"][1].as_u64().unwrap() as usize;
        let catalog_ref = nodes[root_idx][1]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair[0] == Value::Array(vec![Value::from(0), Value::from("catalog")]))
            .unwrap()[1][1]
            .as_u64()
            .unwrap() as usize;
        let entry = nodes[catalog_ref][1]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair[0] == Value::Array(vec![Value::from(0), Value::from(key)]))
            .unwrap();
        entry[1][2].as_str().unwrap().to_owned()
    }

    #[test]
    fn yaml_numbers_carry_exact_source_scalar() {
        assert_eq!(
            raw_catalog_entry("catalog:\n  versioned: 1.10\n", "versioned"),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry("{catalog: { versioned: 1.10 }}\n", "versioned"),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry(
                "catalog:\n  versioned: &pin 1.10\n  other: *pin\n",
                "versioned"
            ),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry("catalog:\n  versioned: &pin 1.10\n  other: *pin\n", "other"),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry("catalog:\n  versioned: !!float 1.10 # pin\n", "versioned"),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry(
                "catalog:\n  a: &pin 1.10\n  b: *pin\n  c: &pin !!float 2.10\n  d: *pin\n",
                "b"
            ),
            "1.10"
        );
        assert_eq!(
            raw_catalog_entry(
                "catalog:\n  a: &pin 1.10\n  b: *pin\n  c: &pin !!float 2.10\n  d: *pin\n",
                "d"
            ),
            "2.10"
        );
        assert_eq!(
            raw_catalog_entry(
                "defaults: &defs\n  versioned: 2.10\ncatalog:\n  <<: *defs\n",
                "versioned"
            ),
            "2.10"
        );
        // Many numeric aliases resolve in a single linear pass.
        let mut many = String::from("catalog:\n  p0: &a 1.10\n");
        for i in 1..2000 {
            many.push_str(&format!("  p{i}: *a\n"));
        }
        assert_eq!(raw_catalog_entry(&many, "p1999"), "1.10");
    }
}
