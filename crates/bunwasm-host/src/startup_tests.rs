//! Original tiny guests exercise cancellation before _start, without guest engine builds.
use super::*;
use process::{Cancellation, FinalOutcome};
use wasm_encoder::{
    CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection, ImportSection,
    Instruction, MemorySection, MemoryType, StartSection, TypeSection, ValType,
};

#[derive(Clone, Copy)]
enum Boundary {
    Slots,
    Instantiate,
}

fn guest(boundary: Boundary, signal: Option<i32>, trap: bool) -> Vec<u8> {
    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I32], [ValType::I32]);
    types.ty().function([], [ValType::I32]);
    types.ty().function([], []);
    let mut imports = ImportSection::new();
    imports.import("runtime_proc", "signal", EntityType::Function(0));
    let mut functions = FunctionSection::new();
    functions.function(1).function(2).function(2);
    let mut memory = MemorySection::new();
    memory.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("_start", ExportKind::Func, 2);
    if matches!(boundary, Boundary::Slots) {
        exports.export("bun_wasm_host_slots", ExportKind::Func, 1);
    }
    let mut slots = Function::new([]);
    emit_failure(&mut slots, signal, trap);
    slots
        .instruction(&Instruction::I32Const(0))
        .instruction(&Instruction::End);
    let mut start = Function::new([]);
    start.instruction(&Instruction::End);
    let mut initializer = Function::new([]);
    emit_failure(&mut initializer, signal, trap);
    initializer.instruction(&Instruction::End);
    let mut code = CodeSection::new();
    code.function(&slots)
        .function(&start)
        .function(&initializer);
    let mut module = wasm_encoder::Module::new();
    module
        .section(&types)
        .section(&imports)
        .section(&functions)
        .section(&memory)
        .section(&exports);
    if matches!(boundary, Boundary::Instantiate) {
        module.section(&StartSection { function_index: 3 });
    }
    module.section(&code);
    module.finish()
}

fn emit_failure(function: &mut Function, signal: Option<i32>, trap: bool) {
    if let Some(signal) = signal {
        function.instruction(&Instruction::I32Const(signal));
        function.instruction(&Instruction::I32Const(3));
        function.instruction(&Instruction::Call(0));
        function.instruction(&Instruction::Drop);
    }
    if trap {
        function.instruction(&Instruction::Unreachable);
    }
}

fn run(bytes: Vec<u8>, cancel: Arc<Cancellation>) -> (FinalOutcome, String, Option<anyhow::Error>) {
    let mut config = Config::new();
    config.epoch_interruption(true);
    let engine = Engine::new(&config).unwrap();
    let module = Module::new(&engine, bytes).unwrap();
    let runtime = process::Runtime::new(engine, module, Vec::new()).unwrap();
    let result = run_instance(
        runtime.clone(),
        Vec::new(),
        Vec::new(),
        process::Stdio::inherited(),
        cancel.clone(),
    );
    let mut diagnostics = Vec::new();
    let outcome = match &result {
        Ok(outcome) => *outcome,
        Err(error) => process::startup_failure(error, &cancel, || &mut diagnostics),
    };
    runtime.shutdown();
    (
        outcome,
        String::from_utf8(diagnostics).unwrap(),
        result.err(),
    )
}

fn is_interruption(cause: &(dyn std::error::Error + 'static)) -> bool {
    cause
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::Interrupted)
}

#[test]
fn fatal_cancel_at_slots_and_instantiation_keeps_signal_without_failure_diagnostic() {
    for boundary in [Boundary::Slots, Boundary::Instantiate] {
        let cancel = Arc::new(Cancellation::default());
        let (outcome, diagnostic, error) = run(guest(boundary, Some(15), false), cancel.clone());
        let error = error.expect("signal must interrupt the pre-entry Wasm call");
        assert!(error.chain().any(is_interruption));
        assert_eq!(outcome, FinalOutcome::Signal(15));
        assert_eq!(outcome.code(), 143);
        assert_eq!(cancel.start_status(), -11);
        assert_eq!(diagnostic, "", "fatal cancellation is not a startup error");
        assert!(!cancel.kill(9));
    }
}

#[test]
fn fatal_cancel_before_entry_keeps_signal_without_failure_diagnostic() {
    let cancel = Arc::new(Cancellation::default());
    assert!(cancel.kill(15));
    let (outcome, diagnostic, _) = run(guest(Boundary::Instantiate, None, false), cancel.clone());
    assert_eq!(outcome, FinalOutcome::Signal(15));
    assert_eq!(cancel.start_status(), -11);
    assert_eq!(diagnostic, "");
    assert!(!cancel.kill(9));
}

#[test]
fn real_startup_failures_survive_absent_ignored_and_handled_signals() {
    for disposition in [0, 1, 2] {
        let cancel = Arc::new(Cancellation::default());
        let signal = (disposition != 0).then_some(15);
        assert_eq!(cancel.signal(15, disposition), 0);
        let (outcome, diagnostic, error) =
            run(guest(Boundary::Slots, signal, false), cancel.clone());
        assert!(error.is_some());
        assert_eq!(outcome, FinalOutcome::StartFailed(45));
        assert!(
            diagnostic.contains("host slot table must be ABI"),
            "{diagnostic}"
        );
        assert_eq!(cancel.start_status(), 45);
        assert!(!cancel.kill(9));
    }
}

#[test]
fn real_startup_traps_keep_their_diagnostic_and_startup_kind() {
    let cancel = Arc::new(Cancellation::default());
    let (outcome, diagnostic, _) = run(guest(Boundary::Slots, None, true), cancel);
    assert_eq!(outcome, FinalOutcome::StartFailed(45));
    assert!(diagnostic.contains("unreachable"), "{diagnostic}");
}

#[test]
fn unrequested_interrupted_io_is_still_a_startup_failure() {
    for disposition in [0, 1, 2] {
        let cancel = Cancellation::default();
        if disposition != 0 {
            assert_eq!(cancel.signal(15, disposition), 0);
            assert!(cancel.kill(15));
        }
        let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::Interrupted))
            .context("unrequested startup I/O");
        let mut diagnostic = Vec::new();
        assert_eq!(
            process::startup_failure(&error, &cancel, || &mut diagnostic),
            FinalOutcome::StartFailed(29)
        );
        assert!(
            String::from_utf8(diagnostic)
                .unwrap()
                .contains("unrequested startup I/O")
        );
    }
}

#[test]
fn startup_failure_selects_before_reporting_and_rejects_late_kill() {
    struct Diagnostic<'a> {
        cancel: &'a Cancellation,
        kill_accepted: bool,
        bytes: Vec<u8>,
    }
    impl std::io::Write for Diagnostic<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.kill_accepted |= self.cancel.kill(9);
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let cancel = Cancellation::default();
    let mut diagnostic = Diagnostic {
        cancel: &cancel,
        kill_accepted: false,
        bytes: Vec::new(),
    };
    let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    assert_eq!(
        process::startup_failure(&error, &cancel, || &mut diagnostic),
        FinalOutcome::StartFailed(2)
    );
    assert!(!diagnostic.kill_accepted);
    assert_eq!(cancel.start_status(), 2);
    assert!(
        String::from_utf8(diagnostic.bytes)
            .unwrap()
            .starts_with("bun-wasm child: ")
    );
}

#[test]
fn startup_failure_selects_before_acquiring_diagnostics() {
    let cancel = Cancellation::default();
    let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    let mut diagnostic = Vec::new();
    let outcome = process::startup_failure(&error, &cancel, || {
        assert_eq!(cancel.start_status(), 2);
        assert!(!cancel.kill(9));
        &mut diagnostic
    });
    assert_eq!(outcome, FinalOutcome::StartFailed(2));
    assert!(!diagnostic.is_empty());
}

#[test]
fn selected_signal_never_acquires_diagnostics() {
    let cancel = Cancellation::default();
    assert!(cancel.kill(15));
    let error = anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::Interrupted));
    let outcome = process::startup_failure(&error, &cancel, || -> Vec<u8> {
        panic!("signal death must not acquire a diagnostic writer")
    });
    assert_eq!(outcome, FinalOutcome::Signal(15));
}
