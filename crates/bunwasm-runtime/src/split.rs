//! Process-owned data transport and the single linked engine entry.
use std::cell::{Cell, RefCell};
use std::num::NonZeroU32;
use std::rc::Rc;

use crate::data::{Args, DataFn, NativeError, NativeResult, Record, Val};
use crate::{Entry, Options, State, host, modules, natives, new_state, ops, resolve, split_api};

type Run = extern "C" fn(u32) -> i32;

thread_local! {
    static ENGINE: Cell<Option<Run>> = const { Cell::new(None) };
    static SESSION: RefCell<Option<Rc<ops::Dispatcher>>> = const { RefCell::new(None) };
    static TRANSPORT: ops::abi::Transport = ops::abi::Transport::default();
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_bind_engine(run: Run) {
    ENGINE.with(|entry| assert!(entry.replace(Some(run)).is_none(), "engine already bound"));
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_alloc(bytes: u32, align: u32) -> u32 {
    TRANSPORT.with(|transport| transport.alloc(bytes, align))
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_free(pointer: u32, bytes: u32, align: u32) {
    TRANSPORT.with(|transport| {
        transport
            .free(pointer, bytes, align)
            .expect("owned transport")
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_dispatch(frame: u32) -> u32 {
    let dispatcher = SESSION.with(|session| session.borrow().clone());
    let Some(dispatcher) = dispatcher else {
        return ops::Status::BadCall as u32;
    };
    TRANSPORT.with(|transport| transport.dispatch(&dispatcher, frame) as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn core_checkpoint() -> u32 {
    u32::from(crate::host::signal(0, 4) < 0)
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_idle(ms: i32) {
    host::idle(ms);
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_poll(ms: i32) -> i32 {
    let result = host::poll(ms);
    if result == host::UNSUPPORTED {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    result
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_core_exit(code: i32) -> ! {
    SESSION_STATE.with(|state| state.borrow().as_ref().expect("active process").exit(code))
}

thread_local! {
    static SESSION_STATE: RefCell<Option<Rc<State>>> = const { RefCell::new(None) };
}

fn source(state: &State, args: Args<'_>) -> NativeResult {
    let mode = args.str(0)?;
    let name = args.str(1)?;
    if mode == "eval" {
        let (name, source) = modules::eval_entry(state, name);
        return Ok(Val::Array(vec![name.into(), source.into()]));
    }
    if mode == "module" && resolve::builtin_name(name).is_some() {
        return Ok(Val::Array(vec!["builtin".into(), "".into()]));
    }
    let (code, format) = state.load_source(name)?;
    if mode == "cjs" {
        let (code, line) = modules::cjs_wrapper(&code);
        return Ok(Val::Array(vec![code.into(), line.into()]));
    }
    if mode != "module" {
        return Err(NativeError::type_error("unknown source preparation mode"));
    }
    let code = if format == modules::Format::Esm {
        modules::esm_source(state, name, &code)
    } else {
        code.to_string()
    };
    Ok(Val::Array(vec![format.name().into(), code.into()]))
}

fn resolve(state: &State, args: Args<'_>) -> NativeResult {
    let specifier = args.str(0)?;
    let referrer = args.str(1)?;
    let from = if referrer.is_empty() || resolve::builtin_name(referrer).is_some() {
        format!("{}/", state.cwd())
    } else {
        referrer.to_owned()
    };
    match state
        .resolver
        .resolve(specifier, &from, resolve::Kind::Import)
    {
        Ok(resolve::Resolved::Builtin(name)) => Ok(Val::Array(vec![name.into(), true.into()])),
        Ok(resolve::Resolved::File(name)) => Ok(Val::Array(vec![name.into(), false.into()])),
        Err(message) => Err(modules::resolve_error(
            &message,
            specifier,
            &from,
            resolve::Kind::Import,
            state.resolver.notes(),
        )),
    }
}

fn wrapper(args: Args<'_>) -> NativeResult {
    let keys = args
        .array(0)
        .ok_or_else(|| NativeError::type_error("expected wrapper keys"))?;
    let keys = keys
        .iter()
        .map(|key| {
            let Val::Str(key) = key else {
                return Err(NativeError::type_error("expected wrapper key"));
            };
            Ok(key.clone())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(modules::wrapper_source(&keys).into())
}

fn dispatcher(state: &Rc<State>, entry: &Entry, main_path: &str) -> Rc<ops::Dispatcher> {
    let table = natives::table(state);
    let names = Val::Array(
        table
            .functions
            .iter()
            .map(|(name, _)| Val::from(*name))
            .collect(),
    );
    let constants = Val::Object(
        table
            .constants
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    );
    let entry = match entry {
        Entry::File(_) => Val::Array(vec!["file".into(), main_path.into()]),
        Entry::Eval(code) => Val::Array(vec!["eval".into(), code.as_str().into()]),
        Entry::Test(args) => Val::Array(vec![
            "test".into(),
            Val::Array(args.iter().map(|arg| Val::from(arg.as_str())).collect()),
        ]),
    };
    let description: Val = Record::new()
        .set("functions", names)
        .set("constants", constants)
        .set("entry", entry)
        .set("main", main_path)
        .into();
    let mut entries: Vec<(u32, DataFn)> = table
        .functions
        .into_iter()
        .enumerate()
        .map(|(index, (_, function))| {
            (
                ops::DATA_NATIVE
                    .checked_add(u32::try_from(index).expect("native ID"))
                    .expect("native op"),
                function,
            )
        })
        .collect();
    entries.push((
        split_api::DESCRIBE,
        Rc::new(move |_| Ok(description.clone())),
    ));
    let st = state.clone();
    entries.push((split_api::RESOLVE, Rc::new(move |args| resolve(&st, args))));
    let st = state.clone();
    entries.push((
        split_api::PREPARE_SOURCE,
        Rc::new(move |args| source(&st, args)),
    ));
    entries.push((
        split_api::POLYFILL_SOURCE,
        Rc::new(|args| {
            modules::polyfill_source(args.str(0)?)
                .map(Val::from)
                .ok_or_else(|| NativeError::error("missing internal module"))
        }),
    ));
    let st = state.clone();
    entries.push((
        split_api::TAKE_TICK,
        Rc::new(move |_| Ok(st.tick_pending.replace(false).into())),
    ));
    let st = state.clone();
    entries.push((
        split_api::FLUSH,
        Rc::new(move |_| {
            st.flush();
            Ok(Val::Undefined)
        }),
    ));
    entries.push((split_api::WRAPPER_SOURCE, Rc::new(wrapper)));
    let st = state.clone();
    entries.push((
        split_api::MAIN_PATH,
        Rc::new(move |_| Ok(st.main.borrow().clone().into())),
    ));
    Rc::new(ops::Dispatcher::registry(NonZeroU32::MIN, entries).expect("unique data operations"))
}

pub(crate) fn run(options: Options) -> i32 {
    let Some(run) = ENGINE.with(Cell::get) else {
        eprintln!("QuickJS engine is not registered");
        return 1;
    };
    let (state, main_path) = new_state(&options.entry, &options.args, options.transpiler);
    SESSION.with(|session| {
        assert!(
            session
                .replace(Some(dispatcher(&state, &options.entry, &main_path)))
                .is_none()
        )
    });
    SESSION_STATE.with(|current| assert!(current.replace(Some(state.clone())).is_none()));
    let code = run(1);
    SESSION.with(|session| session.take());
    SESSION_STATE.with(|current| current.take());
    state.directories.borrow_mut().close_all();
    state.flush();
    code
}
