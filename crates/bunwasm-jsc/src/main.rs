//! `bun-jsc run <entry> [args...]`: Bun's real bundler and Bun's real JavaScriptCore, in wasm.
//!
//! The entry point is bundled first with Bun's bundler (bunwasm-build, `--target bun --format
//! esm`) into one ES module: TypeScript, JSX, CommonJS and node_modules come with the bundler.
//! JSC's module loader then evaluates it (cpp/helpers.cpp supplies the loader hooks the C API
//! lacks), so top-level await, `import()` and `import.meta` work. The imports left in the bundle
//! are builtins, served from `require` in js/prelude.js.
use std::io::Write as _;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use bunwasm_build::{BuildArgs, Format, SourceMap, Target};
use bunwasm_jsc::{native, BUN_VERSION, Js, JsResult, Thrown};
use bunwasm_jsc::sys::{JSObjectRef, JSValueRef};

const PRELUDE: &str = include_str!("js/prelude.js");
// Shared with bunwasm-runtime (read-only): engine-agnostic factories.
const INSPECT: &str = include_str!("../../bunwasm-runtime/src/js/inspect.js");
const CONSOLE: &str = include_str!("../../bunwasm-runtime/src/js/console.js");
const PATH: &str = include_str!("../../bunwasm-runtime/src/js/path.js");
const BUFFER: &str = include_str!("../../bunwasm-runtime/src/js/buffer.js");

const USAGE: &str = "usage: bun-jsc run <entry.{js,ts,jsx,tsx}> [args...]\n       bun-jsc -e <code>";

static mut START: Option<Instant> = None;

fn start() -> Instant {
    // SAFETY: single-threaded; set once in main before any JS runs.
    unsafe { START.unwrap() }
}

fn arg_string(js: Js, args: &[JSValueRef], i: usize) -> JsResult<String> {
    match args.get(i) {
        Some(&v) => js.to_string(v),
        None => Ok(String::new()),
    }
}

/// Bun's wording for an I/O error: `ENOENT: no such file or directory, open '/x'`.
fn io_error(e: &std::io::Error, syscall: &str, path: &str) -> Thrown {
    use std::io::ErrorKind::*;
    let (code, text) = match e.kind() {
        NotFound => ("ENOENT", "no such file or directory"),
        PermissionDenied => ("EACCES", "permission denied"),
        AlreadyExists => ("EEXIST", "file already exists"),
        NotADirectory => ("ENOTDIR", "not a directory"),
        IsADirectory => ("EISDIR", "illegal operation on a directory"),
        DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        InvalidInput => ("EINVAL", "invalid argument"),
        _ => ("EIO", "i/o error"),
    };
    Thrown::Message(format!("{code}: {text}, {syscall} '{path}'"))
}

fn write_to(out: &mut dyn std::io::Write, js: Js, v: Option<&JSValueRef>) -> JsResult<JSValueRef> {
    let Some(&v) = v else { return Ok(js.undefined()) };
    let r = match js.bytes(v) {
        Some(bytes) => out.write_all(&bytes),
        None => out.write_all(js.to_string(v)?.as_bytes()),
    };
    let _ = r.and_then(|()| out.flush());
    Ok(js.undefined())
}

native!(write_stdout, |js, args| write_to(&mut std::io::stdout().lock(), js, args.first()));
native!(write_stderr, |js, args| write_to(&mut std::io::stderr().lock(), js, args.first()));

native!(read_file_text, |js, args| {
    let path = arg_string(js, args, 0)?;
    let bytes = std::fs::read(&path).map_err(|e| io_error(&e, "open", &path))?;
    Ok(js.string(&String::from_utf8_lossy(&bytes)))
});

native!(read_file_bytes, |js, args| {
    let path = arg_string(js, args, 0)?;
    let bytes = std::fs::read(&path).map_err(|e| io_error(&e, "open", &path))?;
    Ok(js.uint8_array(bytes))
});

native!(write_file, |js, args| {
    let path = arg_string(js, args, 0)?;
    let data = match args.get(1) {
        Some(&v) => match js.bytes(v) {
            Some(b) => b,
            None => js.to_string(v)?.into_bytes(),
        },
        None => Vec::new(),
    };
    let append = args.get(2).is_some_and(|&v| js.to_bool(v));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .map_err(|e| io_error(&e, "open", &path))?;
    file.write_all(&data).map_err(|e| io_error(&e, "write", &path))?;
    Ok(js.number(data.len() as f64))
});

native!(exists, |js, args| {
    let path = arg_string(js, args, 0)?;
    Ok(js.bool(std::fs::metadata(&path).is_ok()))
});

native!(readdir, |js, args| {
    let path = arg_string(js, args, 0)?;
    let mut names: Vec<String> = std::fs::read_dir(&path)
        .map_err(|e| io_error(&e, "scandir", &path))?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    Ok(js.string(&json_array(&names)))
});

native!(mkdir, |js, args| {
    let path = arg_string(js, args, 0)?;
    let recursive = args.get(1).is_some_and(|&v| js.to_bool(v));
    let r = if recursive { std::fs::create_dir_all(&path) } else { std::fs::create_dir(&path) };
    r.map_err(|e| io_error(&e, "mkdir", &path))?;
    Ok(js.undefined())
});

native!(rm, |js, args| {
    let path = arg_string(js, args, 0)?;
    let recursive = args.get(1).is_some_and(|&v| js.to_bool(v));
    let force = args.get(2).is_some_and(|&v| js.to_bool(v));
    let r = match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_dir() && recursive => std::fs::remove_dir_all(&path),
        Ok(m) if m.is_dir() => std::fs::remove_dir(&path),
        Ok(_) => std::fs::remove_file(&path),
        Err(e) => Err(e),
    };
    match r {
        Err(e) if !(force && e.kind() == std::io::ErrorKind::NotFound) => Err(io_error(&e, "rm", &path)),
        _ => Ok(js.undefined()),
    }
});

native!(now, |js, _args| Ok(js.number(start().elapsed().as_secs_f64() * 1000.0)));

native!(sleep, |js, args| {
    let ms = match args.first() {
        Some(&v) => js.to_number(v)?,
        None => 0.0,
    };
    if ms > 0.0 {
        std::thread::sleep(Duration::from_secs_f64(ms / 1000.0));
    }
    Ok(js.undefined())
});

native!(exit, |js, args| {
    let code = match args.first() {
        Some(&v) => js.to_number(v)? as i32,
        None => 0,
    };
    let _ = std::io::stdout().flush();
    std::process::exit(code)
});

native!(cwd, |js, _args| {
    let dir = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "/".into());
    Ok(js.string(&dir))
});

native!(encode_utf8, |js, args| {
    let s = arg_string(js, args, 0)?;
    Ok(js.uint8_array(s.into_bytes()))
});

native!(decode_utf8, |js, args| {
    let Some(&v) = args.first() else { return Ok(js.string("")) };
    let bytes = js.bytes(v).ok_or("decode: expected a typed array")?;
    let fatal = args.get(1).is_some_and(|&v| js.to_bool(v));
    let text = if fatal {
        String::from_utf8(bytes).map_err(|_| "The encoded data was not valid for encoding utf-8")?
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(js.string(&text))
});

native!(decode_base64, |js, args| {
    let text = arg_string(js, args, 0)?;
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(js.uint8_array(out))
});

native!(promise_state, |js, args| Ok(js.number(args.first().map_or(-1, |&v| js.promise_state(v)) as f64)));
native!(promise_result, |js, args| Ok(args.first().map_or(js.undefined(), |&v| js.promise_result(v))));
native!(proxy_target, |js, args| Ok(args.first().and_then(|&v| js.proxy_target(v)).unwrap_or(js.null())));

/// `(promise, reason)` from JSC's unhandled-rejection callback, forwarded to the prelude.
static mut HOOKS: JSObjectRef = core::ptr::null_mut();

native!(on_unhandled_rejection, |js, args| {
    // SAFETY: HOOKS is set (and protected) before any JS runs.
    let hooks = unsafe { HOOKS };
    let handler = js.get(hooks, "handleRejection")?;
    let promise = args.first().copied().unwrap_or(js.undefined());
    let reason = args.get(1).copied().unwrap_or(js.undefined());
    js.call(handler, hooks, &[promise, reason])?;
    Ok(js.undefined())
});

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn json_array(items: &[String]) -> String {
    let parts: Vec<String> = items.iter().map(|s| json_string(s)).collect();
    format!("[{}]", parts.join(","))
}

fn json_env() -> String {
    let parts: Vec<String> = std::env::vars().map(|(k, v)| format!("{}:{}", json_string(&k), json_string(&v))).collect();
    format!("{{{}}}", parts.join(","))
}

fn natives(js: Js, argv: &[String]) -> JSObjectRef {
    let o = js.object();
    let table: &[(&str, bunwasm_jsc::sys::JSObjectCallAsFunctionCallback)] = &[
        ("writeStdout", write_stdout),
        ("writeStderr", write_stderr),
        ("readFileText", read_file_text),
        ("readFileBytes", read_file_bytes),
        ("writeFile", write_file),
        ("exists", exists),
        ("readdir", readdir),
        ("mkdir", mkdir),
        ("rm", rm),
        ("now", now),
        ("sleep", sleep),
        ("exit", exit),
        ("cwd", cwd),
        ("encodeUtf8", encode_utf8),
        ("decodeUtf8", decode_utf8),
        ("decodeBase64", decode_base64),
        ("promiseState", promise_state),
        ("promiseResult", promise_result),
        ("proxyTarget", proxy_target),
    ];
    for (name, f) in table {
        js.set(o, name, js.function(name, *f));
    }
    js.set(o, "version", js.string(BUN_VERSION));
    js.set(o, "argv", js.string(&json_array(argv)));
    js.set(o, "env", js.string(&json_env()));
    o
}

/// Prints an exception that escaped the prelude's own handling and exits.
fn fatal(js: Js, t: Thrown) -> ! {
    let v = js.thrown_value(t);
    let text = js.to_string(v).unwrap_or_else(|_| "exception".into());
    let stack = js.to_object(v).ok().filter(|o| !o.is_null()).and_then(|o| js.get(o, "stack").ok()).and_then(|s| js.to_string(s).ok());
    eprintln!("error: {text}");
    if let Some(stack) = stack {
        eprintln!("{stack}");
    }
    std::process::exit(1)
}

/// Bundles the entry (Bun's bundler, in memory) into one CommonJS-wrapped script.
fn bundle(entry: &str) -> Result<String, String> {
    let args = BuildArgs {
        entry_points: vec![entry.to_owned()],
        target: Some(Target::Bun),
        format: Format::Esm,
        // Inline, so stack traces map back to the sources (js/prelude.js decodes it).
        sourcemap: SourceMap::Inline,
        write: false,
        ..BuildArgs::default()
    };
    let out = bunwasm_build::build(&args)?;
    if !out.log.is_empty() {
        eprint!("{}", out.log);
    }
    let bytes = match out.stdout {
        Some(b) => b,
        None => out.files.into_iter().next().map(|f| f.contents).ok_or("bundler produced no output")?,
    };
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// Bun's microtask checkpoint: the nextTick queue, then promise jobs, until both are empty.
fn checkpoint(js: Js, hooks: JSObjectRef) -> Result<(), Thrown> {
    let run_ticks = js.get(hooks, "runTicks")?;
    js.call(run_ticks, hooks, &[])?;
    loop {
        js.drain_microtasks();
        // A promise job may have queued ticks; they run before the next promise jobs.
        if !js.to_bool(js.call(run_ticks, hooks, &[])?) {
            return Ok(());
        }
    }
}

fn run(js: Js, hooks: JSObjectRef, entry_path: &str, source: &str) -> Result<(), Thrown> {
    let key = format!("file://{entry_path}");
    let fetch = js.to_object(js.get(hooks, "fetchModule")?)?;
    let import_meta = js.to_object(js.get(hooks, "importMeta")?)?;
    js.set_module_hooks(fetch, import_meta);
    let (k, s) = (js.string(&key), js.string(source));
    js.call(js.get(hooks, "setEntry")?, hooks, &[k, s])?;
    // Fetch and parse (microtasks), then run the body as a task of its own.
    let loaded = js.load_module(&key);
    js.drain_microtasks();
    if js.promise_state(loaded) == 2 {
        uncaught(js, hooks, Thrown::Value(js.promise_result(loaded)))?;
        return Ok(());
    }
    let evaluated = js.evaluate_module(&key);
    js.call(js.get(hooks, "watchMain")?, hooks, &[evaluated])?;
    checkpoint(js, hooks)?;
    let next_delay = js.get(hooks, "nextDelay")?;
    let run_timer = js.get(hooks, "runTimer")?;
    js.protect(next_delay);
    js.protect(run_timer);
    loop {
        let delay = js.to_number(js.call(next_delay, hooks, &[])?)?;
        if delay < 0.0 {
            break;
        }
        if delay > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(delay / 1000.0));
        }
        if let Err(err) = js.call(run_timer, hooks, &[]) {
            uncaught(js, hooks, err)?;
        }
        checkpoint(js, hooks)?;
    }
    Ok(())
}

fn uncaught(js: Js, hooks: JSObjectRef, err: Thrown) -> Result<(), Thrown> {
    let handler = js.get(hooks, "handleUncaught")?;
    let value = js.thrown_value(err);
    js.call(handler, hooks, &[value])?;
    checkpoint(js, hooks)
}

fn main() -> ExitCode {
    // SAFETY: single-threaded, before any reader.
    unsafe { START = Some(Instant::now()) };
    #[cfg(target_os = "wasi")]
    bunwasm_glue::init();

    let mut argv: Vec<String> = std::env::args().collect();
    let (entry, script) = match argv.get(1).map(String::as_str) {
        Some("run") if argv.len() > 2 => {
            argv.remove(1);
            (argv[1].clone(), None)
        }
        Some("-e") | Some("--eval") if argv.len() > 2 => {
            let code = argv.remove(2);
            argv.truncate(1);
            ("/[eval]".to_owned(), Some(code))
        }
        Some(a) if !a.starts_with('-') && a != "run" => (a.to_owned(), None),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    let entry_path = if script.is_some() || entry.starts_with('/') {
        entry.clone()
    } else {
        let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "/".into());
        format!("{}/{}", cwd.trim_end_matches('/'), entry.trim_start_matches("./"))
    };
    let script = match script {
        Some(s) => s,
        None => match bundle(&entry_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(1);
            }
        },
    };
    argv[0] = "bun".to_owned();
    if argv.len() > 1 {
        argv[1] = entry_path.clone();
    }

    let js = Js::new_context();
    js.enter();
    let factories = js.object();
    for (name, src) in [("inspect", INSPECT), ("console", CONSOLE), ("path", PATH), ("buffer", BUFFER)] {
        match js.eval(src, &format!("bun-jsc:{name}")) {
            Ok(f) => js.set(factories, name, f),
            Err(e) => fatal(js, e),
        }
    }
    let nat = natives(js, &argv);
    let hooks = match js.eval(PRELUDE, "bun-jsc:prelude").and_then(|f| js.call(f, core::ptr::null_mut(), &[nat, factories])) {
        Ok(h) => js.to_object(h).unwrap_or_else(|e| fatal(js, e)),
        Err(e) => fatal(js, e),
    };
    js.protect(hooks);
    // SAFETY: single-threaded; read only by on_unhandled_rejection.
    unsafe { HOOKS = hooks };
    js.set_unhandled_rejection_callback(js.function("onUnhandledRejection", on_unhandled_rejection));

    if let Err(e) = run(js, hooks, &entry_path, &script) {
        fatal(js, e);
    }
    let code = js
        .get(hooks, "exit")
        .and_then(|f| js.call(f, hooks, &[]))
        .and_then(|v| js.to_number(v))
        .unwrap_or(1.0);
    let _ = std::io::stdout().flush();
    ExitCode::from(code as u8)
}
