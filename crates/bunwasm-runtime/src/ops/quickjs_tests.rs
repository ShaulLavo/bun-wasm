use super::*;

use std::collections::HashMap;

fn engine() -> (QuickJs, Rc<crate::Core<QuickJs>>) {
    let state = Rc::new(crate::State::new(
        Vec::new(),
        Box::new(crate::PassthroughTranspiler),
    ));
    let core = Rc::new(crate::Core {
        state,
        internal: RefCell::new(None),
        handoffs: RefCell::new(HashMap::new()),
    });
    (QuickJs::new(core.clone()), core)
}

#[test]
fn data_ops_stdout_actual_bytes() {
    if std::env::var_os("BUN_DATA_OPS_STDOUT_CHILD").is_none() {
        check_stdout_child();
        return;
    }
    let (engine, core) = engine();
    let (id, (name, native)) = crate::natives::table(&core.state)
        .functions
        .into_iter()
        .enumerate()
        .find(|(_, (name, _))| *name == "writeStdout")
        .unwrap();
    let native = crate::engine_natives::data_fn::<QuickJs>(name, id.try_into().unwrap(), native);
    let function = engine.new_function(name, native);
    engine.ctx().globals().set(name, function).unwrap();
    engine.eval_script("writeStdout('héllo\\0世界'); writeStdout(new Uint8Array([9, 0, 255, 128, 8]).subarray(1, 4));", "stdout-data-ops", 1).unwrap();
    core.state.flush_stdout().unwrap();
    std::mem::forget(engine);
}

fn check_stdout_child() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "engine_quickjs::data_ops_tests::data_ops_stdout_actual_bytes",
            "--nocapture",
        ])
        .env("BUN_DATA_OPS_STDOUT_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = b"h\xc3\xa9llo\0\xe4\xb8\x96\xe7\x95\x8c\0\xff\x80";
    assert!(
        output
            .stdout
            .windows(expected.len())
            .any(|bytes| bytes == expected),
        "{:?}",
        output.stdout
    );
    assert_eq!(
        output
            .stdout
            .windows(expected.len())
            .filter(|bytes| *bytes == expected)
            .count(),
        1
    );
}

#[test]
fn data_ops_stdout_invalid_arguments_throw_engine_error() {
    let (engine, _) = engine();
    let native = crate::engine_natives::stdout_fn::<QuickJs>(
        0,
        Rc::new(|args| {
            args.bytes(0)?;
            Err(NativeError::type_error("write failed").prop("code", "EIO"))
        }),
    );
    let function = engine.new_function("writeStdout", native);
    engine.ctx().globals().set("writeStdout", function).unwrap();
    let result = engine.eval_script("try { writeStdout(new Uint8Array([1])); } catch (error) { [error instanceof TypeError, error.message, error.code] }", "stdout-error", 1).unwrap();
    assert_eq!(
        engine.to_val(&result),
        Val::Array(vec![Val::Bool(true), "write failed".into(), "EIO".into()])
    );
    std::mem::forget(engine);
}
