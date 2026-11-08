#[path = "../../bunwasm-engine-quickjs/src/nested_token.rs"]
mod invocation_tokens;

use super::*;
use crate::process::{Cancellation, Runtime, Stdio};
use std::sync::Arc;
use wasmtime::{Engine, Store, StoreLimitsBuilder};

struct Control {
    store: Store<Host>,
    runtime: Arc<Runtime>,
    group: shm::MemoryGroup,
}
impl Control {
    fn new() -> Self {
        let engine = Engine::default();
        let module = Module::new(&engine, b"\0asm\x01\0\0\0").unwrap();
        let runtime = Runtime::new(engine.clone(), module, Vec::new()).unwrap();
        let group = shm::MemoryGroup::new(&engine, Default::default(), Default::default()).unwrap();
        let member = group.reserve(723).unwrap().launch();
        let net = crate::net::Net::new();
        let cancel = Arc::new(Cancellation::default());
        let processes = crate::process::Processes::new(
            runtime.clone(),
            Stdio::inherited(),
            net.notify(),
            cancel.clone(),
        );
        let watches = crate::fs_watch::Watches::new(net.notify());
        let mut store = Store::new(
            &engine,
            Host {
                nested: State::default(),
                wasi: wasmtime_wasi::WasiCtxBuilder::new().build_p1(),
                net,
                cancel,
                processes,
                watches,
                shm: Some(member),
                memory: None,
                trace: false,
                cwd: "/".into(),
                functions: Vec::new(),
                limits: StoreLimitsBuilder::new().instances(40).build(),
            },
        );
        store.limiter(|host| &mut host.limits);
        Self {
            store,
            runtime,
            group,
        }
    }
    fn run(
        &mut self,
        run: impl Fn(Caller<'_, Host>) -> Result<()> + Send + Sync + 'static,
    ) -> Result<()> {
        Func::wrap(&mut self.store, run)
            .typed::<(), ()>(&self.store)?
            .call(&mut self.store, ())
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        // Store-held weak region closures must not outlive the member backing.
        self.runtime.shutdown();
        let member = self.store.data_mut().shm.take().unwrap();
        self.store.data_mut().nested = State::default();
        member.physical_stopped();
        assert_eq!(self.group.snapshot().regions, 0);
    }
}

#[test]
fn reply_and_snapshot_report_the_selected_reservation_and_the_declared_limit() {
    let mut control = Control::new();
    control
        .run(|mut caller| {
            let request = Request::Reserve {
                initial: 1,
                maximum: 65536,
            };
            let Reply::Handle(memory) = execute(&mut caller, request)? else {
                bail!("reserve reply");
            };
            let Reply::Memory {
                pages,
                maximum,
                committed,
                ..
            } = execute(&mut caller, Request::Span { memory })?
            else {
                bail!("span reply");
            };
            let reserved = 32767 * 65536_u64;
            assert_eq!((pages, maximum, committed), (1, 65536, reserved));
            let snapshot = caller.data().nested.snapshot();
            assert_eq!(
                snapshot["reserved_committed_bytes"],
                serde_json::json!(reserved)
            );
            assert_eq!(snapshot["visible_bytes"], serde_json::json!(65536));
            Ok(())
        })
        .unwrap();
}

#[test]
fn released_slots_reuse_storage_without_reviving_stale_identities() {
    let mut resources = Resources::default();
    let stale = resources.insert(17).unwrap();
    resources.release(stale).unwrap();
    for value in 0..(MAX_RESOURCES * 2) {
        let id = resources.insert(value).unwrap();
        assert_ne!(id, stale);
        assert!(resources.get(stale).is_err());
        assert!(resources.release(stale).is_err());
        assert_eq!(*resources.get(id).unwrap(), value);
        resources.release(id).unwrap();
    }
    assert_eq!(resources.slots.len(), 1);
    resources.slots[0].generation = MAX_GENERATION;
    let last = resources.insert(9).unwrap();
    resources.release(last).unwrap();
    let next = resources.insert(11).unwrap();
    assert_ne!(next, stale);
    assert!(resources.get(last).is_err());
    assert_eq!(resources.slots.len(), 2);
}

fn table_module(engine: &Engine) -> Module {
    use wasm_encoder::{
        CodeSection, ConstExpr, ElementSection, Elements, ExportKind, ExportSection, Function,
        FunctionSection, GlobalSection, GlobalType, RefType as WasmRefType, TableSection,
        TableType, TypeSection, ValType as WasmValType,
    };
    let mut wasm = wasm_encoder::Module::new();
    let mut types = TypeSection::new();
    types.ty().function([], [WasmValType::I32]);
    wasm.section(&types);
    let mut functions = FunctionSection::new();
    functions.function(0);
    wasm.section(&functions);
    let mut tables = TableSection::new();
    tables.table(TableType {
        element_type: WasmRefType::FUNCREF,
        minimum: 2,
        maximum: Some(3),
        table64: false,
        shared: false,
    });
    wasm.section(&tables);
    let mut globals = GlobalSection::new();
    for mutable in [false, true] {
        let ty = GlobalType {
            val_type: WasmValType::I32,
            mutable,
            shared: false,
        };
        globals.global(ty, &ConstExpr::i32_const(5));
    }
    wasm.section(&globals);
    let mut exports = ExportSection::new();
    exports.export("t", ExportKind::Table, 0);
    exports.export("fixed", ExportKind::Global, 0);
    exports.export("open", ExportKind::Global, 1);
    wasm.section(&exports);
    let mut elements = ElementSection::new();
    let entries = [0u32];
    elements.active(
        None,
        &ConstExpr::i32_const(0),
        Elements::Functions(entries.as_slice().into()),
    );
    wasm.section(&elements);
    let mut code = CodeSection::new();
    let mut body = Function::new([]);
    body.instructions().i32_const(1).end();
    code.function(&body);
    wasm.section(&code);
    Module::new(engine, wasm.finish()).unwrap()
}

fn range_category(error: anyhow::Error) -> String {
    match error_reply(error, "RuntimeError") {
        Reply::Error { category, .. } => category,
        _ => panic!("expected an error reply"),
    }
}

#[test]
fn tables_and_globals_answer_typed_requests_and_report_range_errors() {
    let mut control = Control::new();
    let module = table_module(control.store.engine());
    control
        .run(move |mut caller| {
            let region = NestedMemory::new(caller.data().shm.as_ref().unwrap(), 1, 1).unwrap();
            let instance = Instance::new(&mut caller, &module, &[])?;
            let guest = Guest {
                instance,
                _memory: region,
            };
            let id = insert(&mut caller.data_mut().nested.instances, guest)?;
            let name = "t".to_owned();
            let Reply::Handle(table) =
                execute(&mut caller, Request::TableExport { instance: id, name })?
            else {
                panic!("expected a table handle");
            };
            let length = execute(&mut caller, Request::TableLength { table })?;
            assert!(matches!(length, Reply::Count(2)));
            let get = |index| Request::TableGet { table, index };
            let Reply::Function { id: entry, .. } = execute(&mut caller, get(0))? else {
                panic!("expected a table function");
            };
            assert!(matches!(execute(&mut caller, get(1))?, Reply::Null));
            let outside = execute(&mut caller, get(2)).err().unwrap();
            assert_eq!(range_category(outside), "RangeError");

            let set = |index, function| Request::TableSet {
                table,
                index,
                function,
            };
            execute(&mut caller, set(1, Some(entry)))?;
            let Reply::Function { id: same, .. } = execute(&mut caller, get(1))? else {
                panic!("expected the stored function");
            };
            assert_eq!(same, entry);
            let outside = execute(&mut caller, set(2, None)).err().unwrap();
            assert_eq!(range_category(outside), "RangeError");
            assert!(execute(&mut caller, set(0, Some(7))).is_err());

            let grow = |delta| Request::TableGrow {
                table,
                delta,
                function: None,
            };
            assert!(matches!(execute(&mut caller, grow(1))?, Reply::Count(2)));
            let outside = execute(&mut caller, grow(1)).err().unwrap();
            assert_eq!(range_category(outside), "RangeError");

            let name = "open".to_owned();
            let value = Number::I32(9);
            let write = Request::GlobalSet {
                instance: id,
                name: name.clone(),
                value,
            };
            execute(&mut caller, write)?;
            let read = Request::GlobalGet { instance: id, name };
            let Reply::Values(values) = execute(&mut caller, read)? else {
                panic!("expected a global value");
            };
            assert!(matches!(values.as_slice(), [Number::I32(9)]));
            let name = "fixed".to_owned();
            let refused = Request::GlobalSet {
                instance: id,
                name,
                value,
            };
            assert!(execute(&mut caller, refused).is_err());
            Ok(())
        })
        .unwrap();
}

fn imported_module(engine: &Engine) -> Module {
    let mut wasm = wasm_encoder::Module::new();
    let mut types = wasm_encoder::TypeSection::new();
    types.ty().function([], []);
    types
        .ty()
        .function([wasm_encoder::ValType::I64], [wasm_encoder::ValType::I64]);
    wasm.section(&types);
    let mut imports = wasm_encoder::ImportSection::new();
    imports.import("env", "callback", wasm_encoder::EntityType::Function(0));
    imports.import("env", "peer", wasm_encoder::EntityType::Function(1));
    wasm.section(&imports);
    Module::new(engine, wasm.finish()).unwrap()
}
fn bindings() -> Vec<Binding> {
    vec![
        Binding::Callback {
            module: "env".into(),
            name: "callback".into(),
            id: 0,
        },
        Binding::Function {
            module: "env".into(),
            name: "peer".into(),
            id: BACKEND,
        },
    ]
}

#[test]
fn wrong_function_links_are_rejected_before_store_objects_are_created() {
    let mut control = Control::new();
    let module = imported_module(control.store.engine());
    control.store.data_mut().nested.modules.push(module);
    let wrong = Func::wrap(&mut control.store, || ());
    control.store.data_mut().nested.functions.push(wrong);
    control
        .run(|mut caller| {
            let region = NestedMemory::new(caller.data().shm.as_ref().unwrap(), 1, 2).unwrap();
            let memory = caller.data_mut().nested.memories.insert(region)?;
            for _ in 0..10_000 {
                assert!(instantiate(&mut caller, BACKEND, memory, bindings()).is_err());
            }
            assert_eq!(caller.data().nested.instantiation_attempts, 0);
            assert!(caller.data().nested.admission_error.is_none());
            let valid = Func::wrap(&mut caller, |value: i64| value);
            caller.data_mut().nested.functions[0] = valid;
            assert!(instantiate(&mut caller, BACKEND, memory, bindings()).is_ok());
            assert_eq!(caller.data().nested.instantiation_attempts, 1);
            Ok(())
        })
        .unwrap();
}

fn trapping_start(engine: &Engine) -> Module {
    let mut wasm = wasm_encoder::Module::new();
    let mut types = wasm_encoder::TypeSection::new();
    types.ty().function([], []);
    wasm.section(&types);
    let mut functions = wasm_encoder::FunctionSection::new();
    functions.function(0);
    wasm.section(&functions);
    wasm.section(&wasm_encoder::StartSection { function_index: 0 });
    let mut code = wasm_encoder::CodeSection::new();
    let mut body = wasm_encoder::Function::new([]);
    body.instruction(&wasm_encoder::Instruction::Unreachable);
    body.instruction(&wasm_encoder::Instruction::End);
    code.function(&body);
    wasm.section(&code);
    Module::new(engine, wasm.finish()).unwrap()
}

#[test]
fn failed_starts_close_saturated_store_admission_and_reuse_memory_slots() {
    let mut control = Control::new();
    let module = trapping_start(control.store.engine());
    control.store.data_mut().nested.modules.push(module);
    control
        .run(|mut caller| {
            for _ in 0..5000 {
                let region = NestedMemory::new(caller.data().shm.as_ref().unwrap(), 1, 2).unwrap();
                let memory = caller.data_mut().nested.memories.insert(region)?;
                let error = instantiate(&mut caller, BACKEND, memory, Vec::new())
                    .err()
                    .unwrap();
                if caller.data().nested.admission_error.is_some() {
                    assert!(format!("{error:#}").contains("instance count"));
                }
                caller.data_mut().nested.memories.release(memory)?;
            }
            assert!(caller.data().nested.admission_error.is_some());
            assert_eq!(caller.data().nested.instantiation_attempts, 41);
            assert_eq!(caller.data().nested.memories.slots.len(), 1);
            assert!(!caller.data().nested.core_failed);
            Ok(())
        })
        .unwrap();
}

#[test]
fn core_entry_failures_are_fatal_but_pending_values_are_not() {
    let mut control = Control::new();
    control
        .run(|mut caller| {
            let result: Result<()> = core_result(&mut caller, Err(PendingException.into()));
            assert!(result.unwrap_err().is::<PendingException>());
            assert!(!caller.data().nested.core_failed);
            let result: Result<()> =
                core_result(&mut caller, Err(wasmtime_wasi::I32Exit(7).into()));
            assert_eq!(
                result
                    .unwrap_err()
                    .downcast_ref::<wasmtime_wasi::I32Exit>()
                    .unwrap()
                    .0,
                7
            );
            assert!(caller.data().nested.core_failed);
            let result: Result<()> =
                core_result(&mut caller, Err(wasmtime::Trap::StackOverflow.into()));
            let error = result.unwrap_err();
            assert!(error.is::<wasmtime::Trap>());
            assert_eq!(
                fatal_diagnostic(&error).unwrap(),
                "reentered core failed: wasm trap: call stack exhausted"
            );
            assert!(fatal_diagnostic(&anyhow!("ordinary trap diagnostic")).is_none());
            Ok(())
        })
        .unwrap();
}

#[test]
fn host_start_errors_remain_catchable_without_closing_admission() {
    let mut control = Control::new();
    let mut wasm = wasm_encoder::Module::new();
    let mut types = wasm_encoder::TypeSection::new();
    types.ty().function([], []);
    wasm.section(&types);
    let mut imports = wasm_encoder::ImportSection::new();
    imports.import("env", "start", wasm_encoder::EntityType::Function(0));
    wasm.section(&imports);
    wasm.section(&wasm_encoder::StartSection { function_index: 0 });
    let module = Module::new(control.store.engine(), wasm.finish()).unwrap();
    control.store.data_mut().nested.modules.push(module);
    let plain = Module::new(control.store.engine(), b"\0asm\x01\0\0\0").unwrap();
    control.store.data_mut().nested.modules.push(plain);
    control.run(|mut caller| {
        let region = NestedMemory::new(caller.data().shm.as_ref().unwrap(), 1, 2).unwrap();
        let memory = caller.data_mut().nested.memories.insert(region)?;
        let bindings = vec![Binding::Callback { module: "env".into(), name: "start".into(), id: 0 }];
        let error = instantiate(&mut caller, BACKEND, memory, bindings).err().unwrap();
        assert!(error.is::<NestedExecution>());
        assert!(matches!(error_reply(error, "LinkError"), Reply::Error { category, .. } if category == "RuntimeError"));
        assert!(caller.data().nested.admission_error.is_none());
        assert!(instantiate(&mut caller, BACKEND | 1, memory, Vec::new()).is_ok());
        Ok(())
    }).unwrap();
}
