//! Preview1 and runtime_proc use the same effective descriptor namespace. The
//! process-owned streams are intercepted here; filesystem descriptors remain
//! owned by Wasmtime and are deliberately not transferable through spawn.
use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use wasmtime::{Caller, Func, Linker, Store, Val, ValType};

use super::{AGAIN, BADF, FAULT, INVAL};
use crate::Host;

/// Start sections run before instantiate returns, but already expose memory to imports.
pub(crate) fn memory(caller: &mut Caller<'_, Host>) -> Result<wasmtime::Memory> {
    if let Some(memory) = caller.data().memory {
        return Ok(memory);
    }
    let memory = caller
        .get_export("memory")
        .and_then(|export| export.into_memory())
        .context("bun.wasm exports no memory")?;
    caller.data_mut().memory = Some(memory);
    Ok(memory)
}

/// A host-to-host Func::call has no caller memory export. Re-enter a tiny
/// original Wasm adapter sharing the guest memory before invoking preview1.
struct Delegated {
    original: Func,
    module: wasmtime::Module,
    cached: std::sync::Mutex<Option<Func>>,
}
fn original(linker: &Linker<Host>, store: &mut Store<Host>, name: &str) -> Result<Delegated> {
    let original = linker
        .get(&mut *store, "wasi_snapshot_preview1", name)
        .with_context(|| format!("missing WASI {name}"))?
        .into_func()
        .with_context(|| format!("{name} is not a function"))?;
    fn section(wasm: &mut Vec<u8>, id: u8, bytes: &[u8]) {
        assert!(bytes.len() < 128);
        wasm.extend_from_slice(&[id, bytes.len() as u8]);
        wasm.extend_from_slice(bytes);
    }
    let count = original.ty(&*store).params().len() as u8;
    let mut wasm = b"\0asm\x01\0\0\0".to_vec();
    let mut signature = vec![1, 0x60, count];
    signature.extend(original.ty(&*store).params().map(|ty| match ty {
        ValType::I32 => 0x7f,
        ValType::I64 => 0x7e,
        _ => unreachable!("preview1 parameter"),
    }));
    signature.extend_from_slice(&[1, 0x7f]);
    section(&mut wasm, 1, &signature);
    section(
        &mut wasm,
        2,
        &[2, 1, b't', 1, b'f', 0, 0, 1, b't', 1, b'm', 2, 0, 1],
    );
    section(&mut wasm, 3, &[1, 0]);
    section(
        &mut wasm,
        7,
        &[
            2, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0, 3, b'r', b'u', b'n', 0, 1,
        ],
    );
    let mut body = vec![0];
    for arg in 0..count {
        body.extend_from_slice(&[0x20, arg]);
    }
    body.extend_from_slice(&[0x10, 0, 0x0b]);
    let mut code = vec![1, body.len() as u8];
    code.extend(body);
    section(&mut wasm, 10, &code);
    Ok(Delegated {
        original,
        module: wasmtime::Module::new(store.engine(), wasm)?,
        cached: std::sync::Mutex::new(None),
    })
}
fn call(delegate: &Delegated, caller: &mut Caller<'_, Host>, args: &[i32]) -> Result<i32> {
    let args: Vec<Val> = args.iter().map(|&arg| Val::I32(arg)).collect();
    call_values(delegate, caller, &args)
}
fn call_values(delegate: &Delegated, caller: &mut Caller<'_, Host>, args: &[Val]) -> Result<i32> {
    call_values_in(delegate, caller, args, None)
}
fn call_values_in(
    delegate: &Delegated,
    caller: &mut Caller<'_, Host>,
    args: &[Val],
    supplied_memory: Option<wasmtime::Memory>,
) -> Result<i32> {
    let function = {
        let mut cached = delegate.cached.lock().unwrap();
        if let Some(function) = *cached {
            function
        } else {
            let mut linker = Linker::new(caller.engine());
            linker.define(&mut *caller, "t", "f", delegate.original)?;
            let memory = match supplied_memory {
                Some(memory) => memory,
                None => memory(caller)?,
            };
            linker.define(&mut *caller, "t", "m", memory)?;
            let instance = linker.instantiate(&mut *caller, &delegate.module)?;
            let function = instance
                .get_func(&mut *caller, "run")
                .context("missing adapter")?;
            *cached = Some(function);
            function
        }
    };
    let mut result = [Val::I32(0)];
    function.call(caller, args, &mut result)?;
    Ok(result[0].unwrap_i32())
}

fn span(memory: &[u8], ptr: i32, len: usize) -> Option<std::ops::Range<usize>> {
    let start = ptr as u32 as usize;
    let end = start.checked_add(len)?;
    (end <= memory.len()).then_some(start..end)
}

/// WASI fd_read/fd_write block, unlike their immediate runtime_proc variants.
/// Validate the complete iovec and output before doing any observable I/O.
fn io(
    caller: &mut Caller<'_, Host>,
    write: bool,
    fd: i32,
    ptr: i32,
    count: i32,
    out: i32,
) -> Result<i32> {
    let memory = memory(caller)?;
    let bytes = memory.data(&*caller);
    let Some(len) = (count as u32 as usize).checked_mul(8) else {
        return Ok(-FAULT);
    };
    let (Some(input), Some(output)) = (span(bytes, ptr, len), span(bytes, out, 4)) else {
        return Ok(-FAULT);
    };
    let mut iovecs = Vec::new();
    for iovec in bytes[input].chunks_exact(8) {
        let ptr = i32::from_le_bytes(iovec[..4].try_into().unwrap());
        let len = u32::from_le_bytes(iovec[4..].try_into().unwrap()) as usize;
        let Some(at) = span(bytes, ptr, len) else {
            return Ok(-FAULT);
        };
        iovecs.push(at);
    }
    let mut total = 0u32;
    for at in iovecs {
        if at.is_empty() {
            continue;
        }
        loop {
            caller.data().cancel.check()?;
            let (bytes, host) = memory.data_and_store_mut(&mut *caller);
            let result = if write {
                host.processes.write(fd, &bytes[at.clone()])
            } else {
                host.processes.read(fd, &mut bytes[at.clone()])
            };
            if result == AGAIN && total == 0 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
            if result < 0 {
                if total == 0 {
                    return Ok(-result);
                }
                memory.data_mut(&mut *caller)[output].copy_from_slice(&total.to_le_bytes());
                return Ok(0);
            }
            total += result as u32;
            if result as usize != at.len() {
                memory.data_mut(&mut *caller)[output].copy_from_slice(&total.to_le_bytes());
                return Ok(0);
            }
            break;
        }
    }
    memory.data_mut(&mut *caller)[output].copy_from_slice(&total.to_le_bytes());
    Ok(0)
}

/// Merge stream, filesystem and clock readiness with nonblocking preview1 scans.
/// The delegate uses private memory, so no guest buffers are temporarily changed.
fn poll_oneoff(
    caller: &mut Caller<'_, Host>,
    delegate: &Delegated,
    scratch: wasmtime::Memory,
    namespace: &Namespace,
    input: i32,
    output: i32,
    count: i32,
    out_count: i32,
) -> Result<i32> {
    let memory = memory(caller)?;
    let count = count as u32 as usize;
    if count == 0 {
        return Ok(-INVAL);
    }
    let (Some(input_bytes), Some(output_bytes), Some(count_bytes)) = (
        count
            .checked_mul(48)
            .and_then(|len| span(memory.data(&*caller), input, len)),
        count
            .checked_mul(32)
            .and_then(|len| span(memory.data(&*caller), output, len)),
        span(memory.data(&*caller), out_count, 4),
    ) else {
        return Ok(-FAULT);
    };
    let subscriptions = memory.data(&*caller)[input_bytes].to_vec();
    let process = |sub: &[u8], host: &Host| {
        (sub[8] == 1 || sub[8] == 2)
            && host
                .processes
                .owns(i32::from_le_bytes(sub[16..20].try_into().unwrap()))
    };
    let mut marker = u64::MAX;
    while subscriptions
        .chunks_exact(48)
        .any(|sub| u64::from_le_bytes(sub[..8].try_into().unwrap()) == marker)
    {
        marker -= 1;
    }
    let needed = (count + 1) * 80 + 4;
    let pages = needed.div_ceil(65536) as u64;
    let current_pages = scratch.size(&*caller);
    if pages > current_pages && scratch.grow(&mut *caller, pages - current_pages).is_err() {
        return Ok(48);
    } // ENOMEM
    let started = std::time::Instant::now();
    loop {
        caller.data().cancel.check()?;
        if caller.data().cancel.interrupted() {
            return Ok(-super::INTR);
        }
        let mut events = Vec::new();
        let mut delegated = Vec::new();
        for sub in subscriptions.chunks_exact(48) {
            if process(sub, caller.data()) {
                let fd = i32::from_le_bytes(sub[16..20].try_into().unwrap());
                let readiness = caller.data().processes.readiness(fd, sub[8] == 2);
                if !matches!(readiness, Ok((false, false))) {
                    let mut event = [0; 32];
                    event[..8].copy_from_slice(&sub[..8]);
                    event[10] = sub[8];
                    match readiness {
                        Ok((_, hungup)) => {
                            event[24..26].copy_from_slice(&u16::from(hungup).to_le_bytes())
                        }
                        Err(error) => event[8..10].copy_from_slice(&(-error as u16).to_le_bytes()),
                    }
                    events.extend_from_slice(&event);
                }
            } else {
                let mut sub: [u8; 48] = sub.try_into().unwrap();
                if sub[8] == 1 || sub[8] == 2 {
                    let external = i32::from_le_bytes(sub[16..20].try_into().unwrap());
                    let Some(actual) = namespace.files.get(&external) else {
                        let mut event = [0; 32];
                        event[..8].copy_from_slice(&sub[..8]);
                        event[8..10].copy_from_slice(&(-BADF as u16).to_le_bytes());
                        event[10] = sub[8];
                        events.extend_from_slice(&event);
                        continue;
                    };
                    sub[16..20].copy_from_slice(&actual.to_le_bytes());
                }
                if sub[8] == 0 && u16::from_le_bytes(sub[40..42].try_into().unwrap()) & 1 == 0 {
                    let timeout = u64::from_le_bytes(sub[24..32].try_into().unwrap());
                    let elapsed = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                    sub[24..32].copy_from_slice(&timeout.saturating_sub(elapsed).to_le_bytes());
                }
                delegated.extend_from_slice(&sub);
            }
        }
        if !delegated.is_empty() {
            let mut clock = [0; 48];
            clock[..8].copy_from_slice(&marker.to_le_bytes());
            clock[16..20].copy_from_slice(&1u32.to_le_bytes()); // monotonic, relative zero
            delegated.extend_from_slice(&clock);
            let output_at = delegated.len();
            let count_at = output_at + (delegated.len() / 48) * 32;
            scratch.data_mut(&mut *caller)[..delegated.len()].copy_from_slice(&delegated);
            let result = call_values_in(
                delegate,
                caller,
                &[
                    Val::I32(0),
                    Val::I32(output_at as i32),
                    Val::I32((delegated.len() / 48) as i32),
                    Val::I32(count_at as i32),
                ],
                Some(scratch),
            )?;
            if result != 0 {
                return Ok(result);
            }
            let bytes = scratch.data(&*caller);
            let amount =
                u32::from_le_bytes(bytes[count_at..count_at + 4].try_into().unwrap()) as usize;
            for event in bytes[output_at..output_at + amount * 32].chunks_exact(32) {
                if event[10] != 0 || u64::from_le_bytes(event[..8].try_into().unwrap()) != marker {
                    events.extend_from_slice(event);
                }
            }
        }
        if !events.is_empty() {
            memory.data_mut(&mut *caller)[output_bytes.start..output_bytes.start + events.len()]
                .copy_from_slice(&events);
            memory.data_mut(&mut *caller)[count_bytes]
                .copy_from_slice(&((events.len() / 32) as u32).to_le_bytes());
            return Ok(0);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// Files remain in Wasmtime's private table, but its descriptor numbers are
/// never exposed directly. This map keeps streams and files in one namespace,
/// including when the underlying table reuses a number occupied by a pipe.
struct Namespace {
    initialized: bool,
    closing: Arc<Delegated>,
    files: HashMap<i32, i32>,
    preopens: HashSet<i32>,
}
impl Namespace {
    fn new(count: usize, closing: Arc<Delegated>) -> Self {
        let preopens: HashSet<i32> = (3..3 + count as i32).collect();
        Self {
            initialized: false,
            closing,
            files: preopens.iter().map(|&fd| (fd, fd)).collect(),
            preopens,
        }
    }
    fn initialize(&mut self, caller: &mut Caller<'_, Host>) -> Result<()> {
        if self.initialized {
            return Ok(());
        }
        // All stdio is owned by the process table, including absent bindings.
        // Remove preview1's weak/default views so they can never reappear.
        for fd in 0..3 {
            let result = call(&self.closing, caller, &[fd])?;
            anyhow::ensure!(result == 0, "closing private stdio: WASI errno {result}");
        }
        let mut preopens: Vec<i32> = self.preopens.iter().copied().collect();
        preopens.sort_unstable();
        for fd in preopens {
            if caller.data().processes.owns(fd) {
                let to = self
                    .available(caller.data())
                    .context("no descriptor for preopen")?;
                let actual = self.files.remove(&fd).unwrap();
                self.files.insert(to, actual);
                self.preopens.remove(&fd);
                self.preopens.insert(to);
            }
        }
        self.initialized = true;
        Ok(())
    }
    fn available(&self, host: &Host) -> Option<i32> {
        (3..i32::MAX).find(|fd| !self.files.contains_key(fd) && !host.processes.owns(*fd))
    }
    fn remove(&mut self, fd: i32) {
        self.files.remove(&fd);
        self.preopens.remove(&fd);
    }
    fn close(&mut self, caller: &mut Caller<'_, Host>, fd: i32) -> Result<i32> {
        let Some(&actual) = self.files.get(&fd) else {
            return Ok(-BADF);
        };
        let result = call(&self.closing, caller, &[actual])?;
        if result == 0 {
            self.remove(fd);
        }
        Ok(result)
    }
}

/// Called after memory exists; imports also initialize lazily for start sections.
pub fn initialize(linker: &Linker<Host>, store: &mut Store<Host>) -> Result<()> {
    if store.data().memory.is_none() {
        return Ok(());
    }
    linker
        .get(&mut *store, "__native_process", "initialize")
        .context("missing native descriptor initialization")?
        .into_func()
        .unwrap()
        .typed::<(), ()>(&*store)?
        .call(store, ())
}

pub fn install(linker: &mut Linker<Host>, store: &mut Store<Host>) -> Result<()> {
    let close = Arc::new(original(linker, store, "fd_close")?);
    let namespace = Arc::new(Mutex::new(Namespace::new(
        store.data().processes.preopen_count(),
        close.clone(),
    )));
    let read = original(linker, store, "fd_read")?;
    let write = original(linker, store, "fd_write")?;
    let fdstat = original(linker, store, "fd_fdstat_get")?;
    let filestat = original(linker, store, "fd_filestat_get")?;
    let prestat = original(linker, store, "fd_prestat_get")?;
    let open = original(linker, store, "path_open")?;
    let poll = original(linker, store, "poll_oneoff")?;
    let poll_scratch = wasmtime::Memory::new(&mut *store, wasmtime::MemoryType::new(1, None))?;
    let state = namespace.clone();
    linker.func_wrap(
        "__native_process",
        "initialize",
        move |mut caller: Caller<'_, Host>| -> Result<()> {
            state.lock().unwrap().initialize(&mut caller)
        },
    )?;
    linker.allow_shadowing(true);
    // Every remaining preview1 descriptor operation translates its file handles.
    // Streams have no corresponding private file entry, so they cannot reveal
    // an unrelated directory through path, seek, metadata, or socket operations.
    for name in [
        "fd_advise",
        "fd_allocate",
        "fd_datasync",
        "fd_fdstat_set_flags",
        "fd_fdstat_set_rights",
        "fd_filestat_set_size",
        "fd_filestat_set_times",
        "fd_pread",
        "fd_pwrite",
        "fd_readdir",
        "fd_seek",
        "fd_sync",
        "fd_tell",
        "fd_prestat_dir_name",
        "path_create_directory",
        "path_filestat_get",
        "path_filestat_set_times",
        "path_link",
        "path_readlink",
        "path_remove_directory",
        "path_rename",
        "path_symlink",
        "path_unlink_file",
        "sock_accept",
        "sock_recv",
        "sock_shutdown",
    ] {
        let delegate = original(linker, store, name)?;
        let ty = delegate.original.ty(&*store);
        let state = namespace.clone();
        linker.func_new(
            "wasi_snapshot_preview1",
            name,
            ty,
            move |mut caller, args, results| {
                let mut state = state.lock().unwrap();
                state.initialize(&mut caller)?;
                let indices: &[usize] = match name {
                    "path_link" => &[0, 4],
                    "path_rename" => &[0, 3],
                    "path_symlink" => &[2],
                    _ => &[0],
                };
                let mut args = args.to_vec();
                for &index in indices {
                    let external = args[index].unwrap_i32();
                    let Some(&actual) = state.files.get(&external) else {
                        results[0] = Val::I32(-BADF);
                        return Ok(());
                    };
                    args[index] = Val::I32(actual);
                }
                results[0] = Val::I32(call_values(&delegate, &mut caller, &args)?);
                Ok(())
            },
        )?;
    }
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_close",
        move |mut caller: Caller<'_, Host>, fd: i32| -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            if caller.data().processes.owns(fd) {
                return Ok(-caller.data_mut().processes.close(fd));
            }
            state.close(&mut caller, fd)
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_read",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              ptr: i32,
              count: i32,
              out: i32|
              -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            if caller.data().processes.owns(fd) {
                drop(state);
                io(&mut caller, false, fd, ptr, count, out)
            } else if let Some(&actual) = state.files.get(&fd) {
                call(&read, &mut caller, &[actual, ptr, count, out])
            } else {
                Ok(-BADF)
            }
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_write",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              ptr: i32,
              count: i32,
              out: i32|
              -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            if caller.data().processes.owns(fd) {
                drop(state);
                io(&mut caller, true, fd, ptr, count, out)
            } else if let Some(&actual) = state.files.get(&fd) {
                call(&write, &mut caller, &[actual, ptr, count, out])
            } else {
                Ok(-BADF)
            }
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_renumber",
        move |mut caller: Caller<'_, Host>, from: i32, to: i32| -> Result<i32> {
            if from < 0 || to < 0 {
                return Ok(-INVAL);
            }
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            if !caller.data().processes.owns(from) && !state.files.contains_key(&from) {
                return Ok(-BADF);
            }
            if from == to {
                return Ok(0);
            }
            if state.files.contains_key(&to) {
                let result = state.close(&mut caller, to)?;
                if result != 0 {
                    return Ok(result);
                }
            }
            if caller.data().processes.owns(from) {
                return Ok(-caller.data_mut().processes.renumber(from, to));
            }
            if caller.data().processes.owns(to) {
                caller.data_mut().processes.close(to);
            }
            let actual = state.files.remove(&from).unwrap();
            let preopen = state.preopens.remove(&from);
            state.files.insert(to, actual);
            caller.data_mut().processes.reserve_file(to);
            if preopen {
                state.preopens.insert(to);
            }
            Ok(0)
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "path_open",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              dirflags: i32,
              path: i32,
              length: i32,
              flags: i32,
              rights: i64,
              inheriting: i64,
              fdflags: i32,
              out: i32|
              -> Result<i32> {
            let memory = memory(&mut caller)?;
            let Some(output) = span(memory.data(&caller), out, 4) else {
                return Ok(-FAULT);
            };
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let Some(&actual) = state.files.get(&fd) else {
                return Ok(-BADF);
            };
            let Some(external) = state.available(caller.data()) else {
                return Ok(-super::AGAIN);
            };
            let result = call_values(
                &open,
                &mut caller,
                &[
                    Val::I32(actual),
                    Val::I32(dirflags),
                    Val::I32(path),
                    Val::I32(length),
                    Val::I32(flags),
                    Val::I64(rights),
                    Val::I64(inheriting),
                    Val::I32(fdflags),
                    Val::I32(out),
                ],
            )?;
            if result != 0 {
                return Ok(result);
            }
            let opened =
                i32::from_le_bytes(memory.data(&caller)[output.clone()].try_into().unwrap());
            state.files.insert(external, opened);
            caller.data_mut().processes.reserve_file(external);
            memory.data_mut(&mut caller)[output].copy_from_slice(&external.to_le_bytes());
            Ok(0)
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_prestat_get",
        move |mut caller: Caller<'_, Host>, fd: i32, out: i32| -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            // Keep libc's EBADF-terminated scan moving across non-preopens and
            // holes below a preopen. No private descriptor is revealed at a hole.
            if !state.preopens.contains(&fd)
                && (caller.data().processes.owns(fd)
                    || state.preopens.iter().any(|preopen| *preopen > fd))
            {
                return Ok(-super::NOTSUP);
            }
            match state.files.get(&fd) {
                Some(&actual) => call(&prestat, &mut caller, &[actual, out]),
                None => Ok(-BADF),
            }
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "poll_oneoff",
        move |mut caller: Caller<'_, Host>,
              input: i32,
              output: i32,
              count: i32,
              out_count: i32|
              -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            poll_oneoff(
                &mut caller,
                &poll,
                poll_scratch,
                &state,
                input,
                output,
                count,
                out_count,
            )
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_fdstat_get",
        move |mut caller: Caller<'_, Host>, fd: i32, out: i32| -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let Some((terminal, rights)) = caller.data().processes.fdstat(fd) else {
                return match state.files.get(&fd) {
                    Some(&actual) => call(&fdstat, &mut caller, &[actual, out]),
                    None => Ok(-BADF),
                };
            };
            let memory = memory(&mut caller)?;
            let Some(at) = span(memory.data(&caller), out, 24) else {
                return Ok(-FAULT);
            };
            let output = &mut memory.data_mut(&mut caller)[at];
            output.fill(0);
            output[0] = if terminal { 2 } else { 0 };
            output[8..16].copy_from_slice(&rights.to_le_bytes());
            Ok(0)
        },
    )?;
    let state = namespace.clone();
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_filestat_get",
        move |mut caller: Caller<'_, Host>, fd: i32, out: i32| -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            let Some((terminal, _)) = caller.data().processes.fdstat(fd) else {
                return match state.files.get(&fd) {
                    Some(&actual) => call(&filestat, &mut caller, &[actual, out]),
                    None => Ok(-BADF),
                };
            };
            let memory = memory(&mut caller)?;
            let Some(at) = span(memory.data(&caller), out, 64) else {
                return Ok(-FAULT);
            };
            let output = &mut memory.data_mut(&mut caller)[at];
            output.fill(0);
            output[16] = if terminal { 2 } else { 0 };
            output[24..32].copy_from_slice(&1u64.to_le_bytes());
            Ok(0)
        },
    )?;
    linker.allow_shadowing(false);
    Ok(())
}
