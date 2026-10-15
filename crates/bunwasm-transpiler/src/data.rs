//! Bun's data parsers with an engine-independent, identity-preserving result.
use std::collections::HashMap;

use bun_alloc::Arena;
use bun_ast::{Expr, ExprData, Source};
use serde_json::{Value, json};

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
    let mut graph = Graph::default();
    let root = graph.value(root)?;
    Ok(json!({"root": root, "nodes": graph.nodes}).to_string())
}

#[derive(Default)]
struct Graph {
    seen: HashMap<usize, usize>,
    nodes: Vec<Value>,
    pending: Vec<(Expr, usize)>,
    depth: usize,
}

impl Graph {
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
                let n = n.value();
                let text = if n.is_infinite() {
                    if n < 0.0 {
                        "-Infinity".into()
                    } else {
                        "Infinity".into()
                    }
                } else {
                    n.to_string()
                };
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
