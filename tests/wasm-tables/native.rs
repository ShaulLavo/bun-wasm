use crate::data::{Args, Val};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn number(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return number;
    }
    match value.as_str().unwrap() {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        "-0" => -0.0,
        _ => panic!("invalid number"),
    }
}
fn decode(value: &Value) -> Val {
    let tag = value[0].as_str().expect("wire tag");
    let payload = &value[1];
    match tag {
        "undefined" => Val::Undefined,
        "null" => Val::Null,
        "bool" => Val::Bool(payload.as_bool().unwrap()),
        "number" => Val::Num(number(payload)),
        "bigint" => Val::BigInt(payload.as_str().unwrap().parse().unwrap()),
        "string" => Val::Str(payload.as_str().unwrap().into()),
        "bytes" => Val::Bytes(STANDARD.decode(payload.as_str().unwrap()).unwrap()),
        "array" => Val::Array(payload.as_array().unwrap().iter().map(decode).collect()),
        "object" => Val::Object(
            payload
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| (entry[0].as_str().unwrap().into(), decode(&entry[1])))
                .collect(),
        ),
        _ => panic!("unknown wire tag"),
    }
}
fn encode(value: Val) -> Value {
    match value {
        Val::Undefined => json!(["undefined"]),
        Val::Null => json!(["null"]),
        Val::Bool(value) => json!(["bool", value]),
        Val::Num(value) if value == 0.0 && value.is_sign_negative() => json!(["number", "-0"]),
        Val::Num(value) if value.is_finite() => json!(["number", value]),
        Val::Num(value) => json!([
            "number",
            if value.is_nan() {
                "NaN"
            } else if value.is_sign_negative() {
                "-Infinity"
            } else {
                "Infinity"
            }
        ]),
        Val::BigInt(value) => json!(["bigint", value.to_string()]),
        Val::BigUint(value) => json!(["bigint", value.to_string()]),
        Val::Str(value) => json!(["string", value]),
        Val::Bytes(value) => json!(["bytes", STANDARD.encode(value)]),
        Val::Array(value) => json!(["array", value.into_iter().map(encode).collect::<Vec<_>>()]),
        Val::Object(value) => json!([
            "object",
            value
                .into_iter()
                .map(|(key, value)| { json!([key, encode(value)]) })
                .collect::<Vec<_>>()
        ]),
    }
}
/// Where `wasm.memorySpan` reports a memory resource's bytes. An in-process engine views
/// them in place; this out-of-process client copies them through `bridge.*`.
fn span(table: &natives::Table, id: &Val) -> (*mut u8, usize) {
    let (_, function) = table
        .functions
        .iter()
        .find(|(key, _)| *key == "wasm.memorySpan")
        .unwrap();
    let Val::Object(fields) = function(Args(std::slice::from_ref(id))).unwrap() else {
        panic!("memory span")
    };
    let field = |key: &str| match fields.iter().find(|(name, _)| name == key) {
        Some((_, Val::Num(value))) => *value as usize,
        _ => panic!("memory span field"),
    };
    (field("pointer") as *mut u8, field("length"))
}
fn bridge(table: &natives::Table, name: &str, args: &[Val]) -> Value {
    let (pointer, length) = span(table, &args[0]);
    // SAFETY: the store keeps the span valid until the memory grows, and this process
    // handles one request at a time.
    let bytes = unsafe { std::slice::from_raw_parts_mut(pointer, length) };
    if name == "bridge.read" {
        return json!({"ok": encode(Val::Bytes(bytes.to_vec()))});
    }
    let Val::Bytes(source) = &args[1] else {
        panic!("bridge bytes")
    };
    bytes.copy_from_slice(source);
    json!({"ok": encode(Val::Undefined)})
}
fn dispatch(table: &natives::Table, request: Value) -> Value {
    let name = request["name"].as_str().unwrap();
    if name.starts_with("bridge.") {
        let Val::Array(args) = decode(&request["args"]) else {
            panic!("argument array")
        };
        return bridge(table, name, &args);
    }
    let Some((_, function)) = table.functions.iter().find(|(key, _)| *key == name) else {
        return json!({"error": {"kind":"Error", "message": format!("Missing native {name}")}});
    };
    let Val::Array(args) = decode(&request["args"]) else {
        panic!("argument array")
    };
    match function(Args(&args)) {
        Ok(value) => json!({"ok": encode(value)}),
        Err(error) => {
            json!({"error": {"kind": format!("{:?}", error.kind), "message":error.message}})
        }
    }
}
fn main() {
    let mut table = natives::Table::default();
    wasm::install(&mut table);
    let mut output = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let response = dispatch(&table, request);
        writeln!(output, "{response}").unwrap();
        output.flush().unwrap();
    }
}
