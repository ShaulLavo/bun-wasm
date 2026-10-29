mod common;

use common::{PAGE, Pair, engine};
use wasmtime::Val;

struct Case {
    name: &'static str,
    width: u32,
    atomic: bool,
    operands: &'static str,
    result: &'static str,
    suffix: &'static str,
}

macro_rules! case {
    ($name:literal, $width:literal, $atomic:literal, $operands:literal, $result:literal, $suffix:literal) => {
        Case {
            name: $name,
            width: $width,
            atomic: $atomic,
            operands: $operands,
            result: $result,
            suffix: $suffix,
        }
    };
}

// Independent instruction names, widths and stack operands from the pinned Wasm interface.
const CASES: &[Case] = &[
    case!("i32.load", 4, false, "", "i32", ""),
    case!("i64.load", 8, false, "", "i64", ""),
    case!("f32.load", 4, false, "", "f32", ""),
    case!("f64.load", 8, false, "", "f64", ""),
    case!("i32.load8_s", 1, false, "", "i32", ""),
    case!("i32.load8_u", 1, false, "", "i32", ""),
    case!("i32.load16_s", 2, false, "", "i32", ""),
    case!("i32.load16_u", 2, false, "", "i32", ""),
    case!("i64.load8_s", 1, false, "", "i64", ""),
    case!("i64.load8_u", 1, false, "", "i64", ""),
    case!("i64.load16_s", 2, false, "", "i64", ""),
    case!("i64.load16_u", 2, false, "", "i64", ""),
    case!("i64.load32_s", 4, false, "", "i64", ""),
    case!("i64.load32_u", 4, false, "", "i64", ""),
    case!("i32.store", 4, false, "i32.const 17", "", ""),
    case!("i64.store", 8, false, "i64.const 19", "", ""),
    case!("f32.store", 4, false, "f32.const 1.25", "", ""),
    case!("f64.store", 8, false, "f64.const 2.5", "", ""),
    case!("i32.store8", 1, false, "i32.const 17", "", ""),
    case!("i32.store16", 2, false, "i32.const 17", "", ""),
    case!("i64.store8", 1, false, "i64.const 19", "", ""),
    case!("i64.store16", 2, false, "i64.const 19", "", ""),
    case!("i64.store32", 4, false, "i64.const 19", "", ""),
    case!("memory.atomic.notify", 4, true, "i32.const 2", "i32", ""),
    case!(
        "memory.atomic.wait32",
        4,
        true,
        "i32.const 17 i64.const 0",
        "i32",
        ""
    ),
    case!(
        "memory.atomic.wait64",
        8,
        true,
        "i64.const 19 i64.const 0",
        "i32",
        ""
    ),
    case!("i32.atomic.load", 4, true, "", "i32", ""),
    case!("i64.atomic.load", 8, true, "", "i64", ""),
    case!("i32.atomic.load8_u", 1, true, "", "i32", ""),
    case!("i32.atomic.load16_u", 2, true, "", "i32", ""),
    case!("i64.atomic.load8_u", 1, true, "", "i64", ""),
    case!("i64.atomic.load16_u", 2, true, "", "i64", ""),
    case!("i64.atomic.load32_u", 4, true, "", "i64", ""),
    case!("i32.atomic.store", 4, true, "i32.const 17", "", ""),
    case!("i64.atomic.store", 8, true, "i64.const 19", "", ""),
    case!("i32.atomic.store8", 1, true, "i32.const 17", "", ""),
    case!("i32.atomic.store16", 2, true, "i32.const 17", "", ""),
    case!("i64.atomic.store8", 1, true, "i64.const 19", "", ""),
    case!("i64.atomic.store16", 2, true, "i64.const 19", "", ""),
    case!("i64.atomic.store32", 4, true, "i64.const 19", "", ""),
    case!("i32.atomic.rmw.add", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.add", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.add_u", 1, true, "i32.const 17", "i32", ""),
    case!("i32.atomic.rmw16.add_u", 2, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw8.add_u", 1, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw16.add_u", 2, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw32.add_u", 4, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw.sub", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.sub", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.sub_u", 1, true, "i32.const 17", "i32", ""),
    case!("i32.atomic.rmw16.sub_u", 2, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw8.sub_u", 1, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw16.sub_u", 2, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw32.sub_u", 4, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw.and", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.and", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.and_u", 1, true, "i32.const 17", "i32", ""),
    case!("i32.atomic.rmw16.and_u", 2, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw8.and_u", 1, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw16.and_u", 2, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw32.and_u", 4, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw.or", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.or", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.or_u", 1, true, "i32.const 17", "i32", ""),
    case!("i32.atomic.rmw16.or_u", 2, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw8.or_u", 1, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw16.or_u", 2, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw32.or_u", 4, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw.xor", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.xor", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.xor_u", 1, true, "i32.const 17", "i32", ""),
    case!("i32.atomic.rmw16.xor_u", 2, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw8.xor_u", 1, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw16.xor_u", 2, true, "i64.const 19", "i64", ""),
    case!("i64.atomic.rmw32.xor_u", 4, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw.xchg", 4, true, "i32.const 17", "i32", ""),
    case!("i64.atomic.rmw.xchg", 8, true, "i64.const 19", "i64", ""),
    case!("i32.atomic.rmw8.xchg_u", 1, true, "i32.const 17", "i32", ""),
    case!(
        "i32.atomic.rmw16.xchg_u",
        2,
        true,
        "i32.const 17",
        "i32",
        ""
    ),
    case!("i64.atomic.rmw8.xchg_u", 1, true, "i64.const 19", "i64", ""),
    case!(
        "i64.atomic.rmw16.xchg_u",
        2,
        true,
        "i64.const 19",
        "i64",
        ""
    ),
    case!(
        "i64.atomic.rmw32.xchg_u",
        4,
        true,
        "i64.const 19",
        "i64",
        ""
    ),
    case!(
        "i32.atomic.rmw.cmpxchg",
        4,
        true,
        "i32.const 0 i32.const 17",
        "i32",
        ""
    ),
    case!(
        "i64.atomic.rmw.cmpxchg",
        8,
        true,
        "i64.const 0 i64.const 19",
        "i64",
        ""
    ),
    case!(
        "i32.atomic.rmw8.cmpxchg_u",
        1,
        true,
        "i32.const 0 i32.const 17",
        "i32",
        ""
    ),
    case!(
        "i32.atomic.rmw16.cmpxchg_u",
        2,
        true,
        "i32.const 0 i32.const 17",
        "i32",
        ""
    ),
    case!(
        "i64.atomic.rmw8.cmpxchg_u",
        1,
        true,
        "i64.const 0 i64.const 19",
        "i64",
        ""
    ),
    case!(
        "i64.atomic.rmw16.cmpxchg_u",
        2,
        true,
        "i64.const 0 i64.const 19",
        "i64",
        ""
    ),
    case!(
        "i64.atomic.rmw32.cmpxchg_u",
        4,
        true,
        "i64.const 0 i64.const 19",
        "i64",
        ""
    ),
    case!("v128.load", 16, false, "", "v128", ""),
    case!("v128.load8x8_s", 8, false, "", "v128", ""),
    case!("v128.load8x8_u", 8, false, "", "v128", ""),
    case!("v128.load16x4_s", 8, false, "", "v128", ""),
    case!("v128.load16x4_u", 8, false, "", "v128", ""),
    case!("v128.load32x2_s", 8, false, "", "v128", ""),
    case!("v128.load32x2_u", 8, false, "", "v128", ""),
    case!("v128.load8_splat", 1, false, "", "v128", ""),
    case!("v128.load16_splat", 2, false, "", "v128", ""),
    case!("v128.load32_splat", 4, false, "", "v128", ""),
    case!("v128.load64_splat", 8, false, "", "v128", ""),
    case!("v128.load32_zero", 4, false, "", "v128", ""),
    case!("v128.load64_zero", 8, false, "", "v128", ""),
    case!("v128.store", 16, false, "v128.const i32x4 1 2 3 4", "", ""),
    case!(
        "v128.load8_lane",
        1,
        false,
        "v128.const i32x4 1 2 3 4",
        "v128",
        " 0"
    ),
    case!(
        "v128.load16_lane",
        2,
        false,
        "v128.const i32x4 1 2 3 4",
        "v128",
        " 0"
    ),
    case!(
        "v128.load32_lane",
        4,
        false,
        "v128.const i32x4 1 2 3 4",
        "v128",
        " 0"
    ),
    case!(
        "v128.load64_lane",
        8,
        false,
        "v128.const i32x4 1 2 3 4",
        "v128",
        " 0"
    ),
    case!(
        "v128.store8_lane",
        1,
        false,
        "v128.const i32x4 1 2 3 4",
        "",
        " 0"
    ),
    case!(
        "v128.store16_lane",
        2,
        false,
        "v128.const i32x4 1 2 3 4",
        "",
        " 0"
    ),
    case!(
        "v128.store32_lane",
        4,
        false,
        "v128.const i32x4 1 2 3 4",
        "",
        " 0"
    ),
    case!(
        "v128.store64_lane",
        8,
        false,
        "v128.const i32x4 1 2 3 4",
        "",
        " 0"
    ),
];

#[test]
fn every_memarg_native_value_or_trap_with_nonzero_base() {
    let engine = engine();
    let mut calls = 0;
    for case in CASES {
        for offset in [0, 3, u32::MAX] {
            calls += check_case(&engine, case, offset);
        }
    }
    eprintln!(
        "memarg operators={} offsets=3 executions={calls}",
        CASES.len()
    );
}

fn check_case(engine: &wasmtime::Engine, case: &Case, offset: u32) -> usize {
    let result = if case.result.is_empty() {
        String::new()
    } else {
        format!("(result {})", case.result)
    };
    let shared = if case.atomic { "shared" } else { "" };
    let wat = format!(
        "(module (memory (export \"memory\") 1 2 {shared})
        (func (export \"run\") (param i32) {result}
        local.get 0 {} {} offset={offset} {}))",
        case.operands, case.name, case.suffix
    );
    let data = r#"(data (i32.const 0) "\ff\80\33\12\ab\cd\ef\01\fe\dc\ba\98\76\54\32\10")"#;
    let wat = wat.replacen("(func", &format!("{data} (func"), 1);
    let bytes = wat::parse_str(&wat).unwrap_or_else(|error| panic!("{wat}: {error}"));
    let mut pair =
        Pair::new(engine, &bytes).unwrap_or_else(|error| panic!("{}: {error:?}", case.name));
    let boundary = (PAGE as u32 - case.width).saturating_sub(offset);
    let addresses = [
        0,
        1,
        boundary.saturating_sub(1),
        boundary,
        boundary + 1,
        PAGE as u32 - 1,
        PAGE as u32,
        u32::MAX,
    ];
    for addr in addresses {
        pair.call("run", &[Val::I32(addr as i32)]);
    }
    addresses.len()
}
