mod common;

use std::time::Instant;

use arbitrary::Unstructured;
use common::{Outcome, PAGE, Pair, Run, engine};
use wasm_smith::{Config, Module};
use wasmtime::{Extern, Val, ValType};

const SEED: u64 = 0x4a313161_20261029;

#[test]
fn smith_threads_simd_bulk_differential() {
    let target = std::env::var("BUNWASM_NESTED_CASES")
        .map(|value| value.parse().unwrap())
        .unwrap_or(1000usize);
    let started = Instant::now();
    let engine = engine();
    let mut random = Random(SEED);
    let mut cases = 0;
    let mut modules = 0;
    let mut skipped = 0;
    let mut stats = Stats::default();
    while cases < target {
        assert!(
            started.elapsed().as_secs() < 240,
            "bounded differential budget exceeded after {cases} cases"
        );
        let Some(bytes) = generate(&mut random, &mut stats) else {
            skipped += 1;
            continue;
        };
        bunwasm_nested::regionize(&bytes).expect("supported smith input must compile");
        let native = Run::new(&engine, &bytes, false);
        let region = Run::new(&engine, &bytes, true);
        assert_eq!(native.is_ok(), region.is_ok(), "same instantiation outcome");
        let (Ok(native), Ok(region)) = (native, region) else {
            skipped += 1;
            continue;
        };
        let mut pair = Pair { native, region };
        let functions = functions(&mut pair);
        if functions.is_empty() {
            skipped += 1;
            continue;
        }
        modules += 1;
        stats.shared_modules += usize::from(pair.region.store.data().shared);
        count_sites(&bytes, &mut stats);
        cases += exercise(
            &mut pair,
            &functions,
            &mut random,
            target - cases,
            &mut stats,
        );
        assert!(
            started.elapsed().as_secs() < 240,
            "bounded differential budget exceeded after {cases} cases"
        );
    }
    eprintln!(
        "smith seed={SEED:#x} modules={modules} executions={cases} skipped={skipped} seconds={:.3}; threads/SIMD/bulk enabled; 1 memory normalized to 1 initial/2 maximum pages; bounded atomic/bulk probes; <=3 functions; <=40 instructions/function; termination fuel=32; 128 calls/module",
        started.elapsed().as_secs_f64()
    );
    eprintln!(
        "{stats:?}; other skipped cases are matched instantiation traps or no callable export"
    );
}

fn generate(random: &mut Random, stats: &mut Stats) -> Option<Vec<u8>> {
    let config = Config {
        min_memories: 1,
        max_memories: 1,
        max_memory32_bytes: PAGE as u64,
        memory_max_size_required: true,
        memory64_enabled: false,
        min_funcs: 1,
        max_funcs: 3,
        max_types: 4,
        max_type_size: 8,
        max_instructions: 40,
        max_imports: 0,
        max_tables: 0,
        max_globals: 3,
        max_data_segments: 3,
        allow_start_export: false,
        export_everything: true,
        canonicalize_nans: true,
        gc_enabled: false,
        extended_const_enabled: false,
        exceptions_enabled: false,
        reference_types_enabled: false,
        relaxed_simd_enabled: false,
        tail_call_enabled: false,
        threads_enabled: true,
        simd_enabled: true,
        bulk_memory_enabled: true,
        ..Config::default()
    };
    let entropy: Vec<u8> = (0..8192).map(|_| random.next() as u8).collect();
    let Ok(mut module) = Module::new(config, &mut Unstructured::new(&entropy)) else {
        stats.entropy_rejects += 1;
        return None;
    };
    let fuel = module
        .ensure_termination(32)
        .expect("valid generated instructions");
    let mut output = wasm_encoder::Module::new();
    use wasm_encoder::reencode::Reencode;
    CorpusAdapter {
        fuel,
        shared: false,
        salt: random.next() as u32,
    }
    .parse_core_module(&mut output, wasmparser::Parser::new(0), &module.to_bytes())
    .expect("export fuel in generated module");
    let bytes = output.finish();
    // Native blocking waits cannot be interrupted by Wasmtime fuel. Table tests cover them
    // with mismatch/zero-timeout controls; this corpus excludes modules containing waits.
    if has_wait(&bytes) {
        stats.wait_modules += 1;
        return None;
    }
    Some(bytes)
}

fn has_wait(bytes: &[u8]) -> bool {
    wasmparser::Parser::new(0).parse_all(bytes).any(|payload| {
        let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() else {
            return false;
        };
        body.get_operators_reader()
            .unwrap()
            .into_iter()
            .any(is_wait)
    })
}

fn is_wait(op: wasmparser::Result<wasmparser::Operator<'_>>) -> bool {
    matches!(
        op.unwrap(),
        wasmparser::Operator::MemoryAtomicWait32 { .. }
            | wasmparser::Operator::MemoryAtomicWait64 { .. }
    )
}

fn functions(pair: &mut Pair) -> Vec<(String, Vec<ValType>)> {
    let exports: Vec<_> = pair
        .native
        .instance
        .exports(&mut pair.native.store)
        .map(|export| (export.name().to_owned(), export.into_extern()))
        .collect();
    exports
        .into_iter()
        .filter_map(|(name, export)| {
            let Extern::Func(func) = export else {
                return None;
            };
            Some((name, func.ty(&pair.native.store).params().collect()))
        })
        .collect()
}

fn exercise(
    pair: &mut Pair,
    functions: &[(String, Vec<ValType>)],
    random: &mut Random,
    remaining: usize,
    stats: &mut Stats,
) -> usize {
    let count = remaining.min(128);
    for index in 0..count {
        let (name, types) = &functions[index % functions.len()];
        let params: Vec<_> = types.iter().map(|ty| parameter(ty, random)).collect();
        reset_fuel(&mut pair.native);
        reset_fuel(&mut pair.region);
        match pair.call(name, &params) {
            Outcome::Trap => stats.traps += 1,
            Outcome::Values(_) => stats.returned += 1,
        }
    }
    count
}

fn parameter(ty: &ValType, random: &mut Random) -> Val {
    let bits = random.next();
    match ty {
        ValType::I32 => Val::I32([0, 1, 65535, 65536, -1, bits as i32][bits as usize % 6]),
        ValType::I64 => Val::I64(bits as i64),
        ValType::F32 => Val::F32((bits as f32).to_bits()),
        ValType::F64 => Val::F64((bits as f64).to_bits()),
        ValType::V128 => Val::V128(u128::from(bits).into()),
        ty => Val::default_for_ty(ty).unwrap(),
    }
}

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

struct CorpusAdapter {
    fuel: u32,
    shared: bool,
    salt: u32,
}

impl wasm_encoder::reencode::Reencode for CorpusAdapter {
    type Error = std::convert::Infallible;

    fn memory_type(&mut self, memory: wasmparser::MemoryType) -> wasm_encoder::MemoryType {
        self.shared = memory.shared;
        wasm_encoder::MemoryType {
            minimum: 1,
            maximum: Some(2),
            memory64: false,
            shared: memory.shared,
            page_size_log2: None,
        }
    }

    fn parse_function_body(
        &mut self,
        code: &mut wasm_encoder::CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> Result<(), wasm_encoder::reencode::Error<Self::Error>> {
        let mut function = self.new_function_with_parsed_locals(&body)?;
        self.probe(&mut function);
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            function.instruction(&self.instruction(reader.read()?)?);
        }
        code.function(&function);
        Ok(())
    }

    fn parse_export_section(
        &mut self,
        exports: &mut wasm_encoder::ExportSection,
        section: wasmparser::ExportSectionReader<'_>,
    ) -> Result<(), wasm_encoder::reencode::Error<Self::Error>> {
        wasm_encoder::reencode::utils::parse_export_section(self, exports, section)?;
        exports.export("__j11_fuel", wasm_encoder::ExportKind::Global, self.fuel);
        Ok(())
    }
}

fn reset_fuel(run: &mut Run) {
    let global = run
        .instance
        .get_global(&mut run.store, "__j11_fuel")
        .unwrap();
    global.set(&mut run.store, Val::I32(32)).unwrap();
}

#[derive(Debug, Default)]
struct Stats {
    entropy_rejects: usize,
    wait_modules: usize,
    shared_modules: usize,
    atomic_sites: usize,
    simd_sites: usize,
    bulk_sites: usize,
    traps: usize,
    returned: usize,
}

fn count_sites(bytes: &[u8], stats: &mut Stats) {
    for payload in wasmparser::Parser::new(0).parse_all(bytes) {
        let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() else {
            continue;
        };
        count_body_sites(body, stats);
    }
}

fn count_body_sites(body: wasmparser::FunctionBody<'_>, stats: &mut Stats) {
    for op in body.get_operators_reader().unwrap() {
        let op = op.unwrap();
        let text = format!("{op:?}");
        let name = text.split(' ').next().unwrap();
        stats.atomic_sites += usize::from(name.contains("Atomic"));
        stats.simd_sites += usize::from(name.starts_with("V128") || name.contains('x'));
        stats.bulk_sites += usize::from(matches!(
            op,
            wasmparser::Operator::MemoryCopy { .. }
                | wasmparser::Operator::MemoryFill { .. }
                | wasmparser::Operator::MemoryInit { .. }
        ));
    }
}

impl CorpusAdapter {
    // wasm-smith 0.228 does not generate atomic instructions. Add bounded probes to
    // each generated function; both native and regionized runs receive these same bytes.
    fn probe(&self, function: &mut wasm_encoder::Function) {
        use wasm_encoder::Instruction as I;
        let address = self.salt & 0xfff8;
        if self.shared {
            function
                .instruction(&I::I32Const(address as i32))
                .instruction(&I::I32Const(self.salt as i32));
            function
                .instruction(&I::I32AtomicRmwXor(wasm_encoder::MemArg {
                    offset: 0,
                    align: 2,
                    memory_index: 0,
                }))
                .instruction(&I::Drop);
        }
        function
            .instruction(&I::I32Const(address as i32))
            .instruction(&I::I32Const(self.salt as i32));
        function
            .instruction(&I::I32Const(8))
            .instruction(&I::MemoryFill(0));
        function.instruction(&I::I32Const(((self.salt >> 16) & 0xfff8) as i32));
        function
            .instruction(&I::I32Const(address as i32))
            .instruction(&I::I32Const(8));
        function.instruction(&I::MemoryCopy {
            src_mem: 0,
            dst_mem: 0,
        });
    }
}
