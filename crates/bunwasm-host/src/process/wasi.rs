//! Preview1 and runtime_proc use the same effective descriptor namespace. The
//! process-owned streams are intercepted here; filesystem descriptors remain
//! owned by Wasmtime and are deliberately not transferable through spawn.
use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use wasmtime::{Caller, Func, Linker, Store, Val, ValType};

use super::{AGAIN, BADF, FAULT, INVAL};
use crate::Host;
use crate::guest::GuestMemory;

/// Start sections run before instantiate returns, but already expose memory to imports.
pub(crate) fn memory(caller: &mut Caller<'_, Host>) -> Result<GuestMemory> {
    if let Some(memory) = &caller.data().memory {
        return Ok(memory.clone());
    }
    let memory = caller
        .get_export("memory")
        .and_then(GuestMemory::from_extern)
        .context("bun.wasm exports no memory")?;
    caller.data_mut().memory = Some(memory.clone());
    Ok(memory)
}

/// A host-to-host Func::call has no caller memory export. Re-enter a tiny
/// original Wasm adapter sharing the guest memory before invoking preview1.
struct Delegated {
    original: Func,
    /// The adapter over a private memory, and over a memory group's shared memory.
    module: wasmtime::Module,
    shared: wasmtime::Module,
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
    let header = wasm.clone();
    // Private limits {min 0}; shared limits {min 0, max 65536 pages}.
    let module = |limits: &[u8]| -> Result<wasmtime::Module> {
        let mut wasm = header.clone();
        let mut imports = vec![2, 1, b't', 1, b'f', 0, 0, 1, b't', 1, b'm', 2];
        imports.extend_from_slice(limits);
        section(&mut wasm, 2, &imports);
        delegate_body(&mut wasm, count);
        wasmtime::Module::new(store.engine(), wasm)
    };
    Ok(Delegated {
        original,
        module: module(&[0, 0])?,
        shared: module(&[3, 0, 0x80, 0x80, 0x04])?,
        cached: std::sync::Mutex::new(None),
    })
}

/// The adapter's function, export and code sections after its imports.
fn delegate_body(wasm: &mut Vec<u8>, count: u8) {
    fn section(wasm: &mut Vec<u8>, id: u8, bytes: &[u8]) {
        assert!(bytes.len() < 128);
        wasm.extend_from_slice(&[id, bytes.len() as u8]);
        wasm.extend_from_slice(bytes);
    }
    section(wasm, 3, &[1, 0]);
    section(
        wasm,
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
    section(wasm, 10, &code);
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
                Some(memory) => GuestMemory::Private(memory),
                None => memory(caller)?,
            };
            let module = if memory.is_shared() {
                &delegate.shared
            } else {
                &delegate.module
            };
            // SAFETY: the delegate instance lives in this caller's Store. A group member's Store
            // owner keeps the group backing alive past the Store (`Programs::instantiate`).
            let export = unsafe { memory.export_for_admission() };
            linker.define(&mut *caller, "t", "m", export)?;
            let instance = linker.instantiate(&mut *caller, module)?;
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

fn span(size: usize, ptr: i32, len: usize) -> Option<std::ops::Range<usize>> {
    let start = ptr as u32 as usize;
    let end = start.checked_add(len)?;
    (end <= size).then_some(start..end)
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
    let size = memory.len(&*caller);
    let Some(len) = (count as u32 as usize).checked_mul(8) else {
        return Ok(-FAULT);
    };
    let (Some(input), Some(output)) = (span(size, ptr, len), span(size, out, 4)) else {
        return Ok(-FAULT);
    };
    let table = memory.read(&*caller, input).context("iovec table")?;
    let mut iovecs = Vec::new();
    for iovec in table.as_chunks::<8>().0.iter() {
        let ptr = i32::from_le_bytes(iovec[..4].try_into().unwrap());
        let len = u32::from_le_bytes(iovec[4..].try_into().unwrap()) as usize;
        let Some(at) = span(size, ptr, len) else {
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
            let result = if write {
                memory.view(&mut *caller, std::slice::from_ref(&at), |bytes, host| {
                    host.processes.write(fd, bytes[0])
                })
            } else {
                memory.fill(&mut *caller, at.clone(), |bytes, host| {
                    host.processes.read(fd, bytes)
                })
            }
            .context("validated iovec")?;
            if result == AGAIN && total == 0 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
            if result < 0 {
                if total == 0 {
                    return Ok(-result);
                }
                store_word(&memory, caller, output.start, total)?;
                return Ok(0);
            }
            total += result as u32;
            if result as usize != at.len() {
                store_word(&memory, caller, output.start, total)?;
                return Ok(0);
            }
            break;
        }
    }
    store_word(&memory, caller, output.start, total)?;
    Ok(0)
}

/// Store one little-endian word at an already validated guest offset.
fn store_word(
    memory: &GuestMemory,
    caller: &mut Caller<'_, Host>,
    at: usize,
    word: u32,
) -> Result<()> {
    memory
        .write(caller, at, &word.to_le_bytes())
        .context("validated output word")
}

/// Merge stream, filesystem and clock readiness with nonblocking preview1 scans.
/// The delegate uses private memory, so no guest buffers are temporarily changed.
// Keep the preview1 call's four positional arguments alongside its delegate context.
#[allow(clippy::too_many_arguments)]
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
    let size = memory.len(&*caller);
    let (Some(input_bytes), Some(output_bytes), Some(count_bytes)) = (
        count.checked_mul(48).and_then(|len| span(size, input, len)),
        count
            .checked_mul(32)
            .and_then(|len| span(size, output, len)),
        span(size, out_count, 4),
    ) else {
        return Ok(-FAULT);
    };
    let subscriptions = memory
        .read(&*caller, input_bytes)
        .context("validated subscriptions")?;
    let process = |sub: &[u8], host: &Host| {
        (sub[8] == 1 || sub[8] == 2)
            && host
                .processes
                .owns(i32::from_le_bytes(sub[16..20].try_into().unwrap()))
    };
    let mut marker = u64::MAX;
    while subscriptions
        .as_chunks::<48>()
        .0
        .iter()
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
        for sub in subscriptions.as_chunks::<48>().0.iter() {
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
                let mut sub = *sub;
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
            for event in bytes[output_at..output_at + amount * 32]
                .as_chunks::<32>()
                .0
                .iter()
            {
                if event[10] != 0 || u64::from_le_bytes(event[..8].try_into().unwrap()) != marker {
                    events.extend_from_slice(event);
                }
            }
        }
        if !events.is_empty() {
            memory
                .write(&mut *caller, output_bytes.start, &events)
                .context("validated events")?;
            store_word(
                &memory,
                caller,
                count_bytes.start,
                (events.len() / 32) as u32,
            )?;
            return Ok(0);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

/// runtime_proc has no iovec parameter. Use private memory for the retained
/// preview1 file operation, then copy only its accepted bytes to/from the guest.
/// Stream operations continue using their shared nonblocking open description.
fn file_io(
    caller: &mut Caller<'_, Host>,
    delegate: &Delegated,
    scratch: wasmtime::Memory,
    memory: GuestMemory,
    actual: i32,
    bytes: std::ops::Range<usize>,
    write: bool,
) -> Result<i32> {
    let pages = (bytes.len() + 32).div_ceil(65536) as u64;
    let current = scratch.size(&*caller);
    if pages > current && scratch.grow(&mut *caller, pages - current).is_err() {
        return Ok(-48);
    }
    scratch.data_mut(&mut *caller)[..4].copy_from_slice(&32u32.to_le_bytes());
    scratch.data_mut(&mut *caller)[4..8].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
    if write {
        let source = memory
            .read(&*caller, bytes.clone())
            .context("validated file bytes")?;
        scratch.data_mut(&mut *caller)[32..32 + source.len()].copy_from_slice(&source);
    }
    let result = call_values_in(
        delegate,
        caller,
        &[Val::I32(actual), Val::I32(0), Val::I32(1), Val::I32(16)],
        Some(scratch),
    )?;
    if result != 0 {
        return Ok(-result);
    }
    let count = u32::from_le_bytes(scratch.data(&*caller)[16..20].try_into().unwrap()) as usize;
    anyhow::ensure!(
        count <= bytes.len(),
        "preview1 returned an oversized file operation"
    );
    if !write {
        let read = scratch.data(&*caller)[32..32 + count].to_vec();
        memory
            .write(&mut *caller, bytes.start, &read)
            .context("validated file bytes")?;
    }
    Ok(count as i32)
}

/// Files remain in Wasmtime's private table, but its descriptor numbers are
/// never exposed directly. This map keeps streams and files in one namespace,
/// including when the underlying table reuses a number occupied by a pipe.
struct Namespace {
    initialized: bool,
    closing: Arc<Delegated>,
    files: HashMap<i32, i32>,
    preopens: HashSet<i32>,
    /// Host paths of Wasmtime's descriptors (keyed by its own numbers, which renumbering
    /// keeps), so `runtime_fs.watch_open` can watch the node an open descriptor names.
    paths: HashMap<i32, PathBuf>,
}
impl Namespace {
    fn new(dirs: Vec<PathBuf>, closing: Arc<Delegated>) -> Self {
        let preopens: HashSet<i32> = (3..3 + dirs.len() as i32).collect();
        Self {
            initialized: false,
            closing,
            files: preopens.iter().map(|&fd| (fd, fd)).collect(),
            preopens,
            paths: (3..).zip(dirs).collect(),
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
                // Waffle installs inherited bindings after preopens: the
                // inherited binding replaces, rather than moves, the preopen.
                let result = self.close(caller, fd)?;
                anyhow::ensure!(result == 0, "closing replaced preopen: WASI errno {result}");
            }
        }
        self.initialized = true;
        Ok(())
    }
    fn available(&self, host: &Host) -> Option<i32> {
        (3..i32::MAX).find(|fd| !self.files.contains_key(fd) && !host.processes.owns(*fd))
    }
    fn remove(&mut self, fd: i32) {
        if let Some(actual) = self.files.remove(&fd) {
            self.paths.remove(&actual);
        }
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
        store.data().processes.preopen_dirs(),
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
    // Separate delegate instances cache the private scratch memory rather than
    // the guest memory used by ordinary WASI calls.
    let file_read = original(linker, store, "fd_read")?;
    let file_write = original(linker, store, "fd_write")?;
    let state = namespace.clone();
    linker.func_wrap(
        "__native_process",
        "initialize",
        move |mut caller: Caller<'_, Host>| -> Result<()> {
            state.lock().unwrap().initialize(&mut caller)
        },
    )?;
    linker.allow_shadowing(true);
    let kind_stat = original(linker, store, "fd_fdstat_get")?;
    let kind_memory = wasmtime::Memory::new(&mut *store, wasmtime::MemoryType::new(1, None))?;
    let state = namespace.clone();
    linker.func_wrap(
        "runtime_proc",
        "fd_kind",
        move |mut caller: Caller<'_, Host>, fd: i32| -> Result<i32> {
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            if caller.data().processes.owns(fd) {
                return Ok(caller.data().processes.fd_kind(fd));
            }
            let Some(&actual) = state.files.get(&fd) else {
                return Ok(BADF);
            };
            let result = call_values_in(
                &kind_stat,
                &mut caller,
                &[Val::I32(actual), Val::I32(0)],
                Some(kind_memory),
            )?;
            if result != 0 {
                return Ok(-result);
            }
            Ok(match kind_memory.data(&caller)[0] {
                4 => 3,
                3 => 4,
                _ => 0,
            })
        },
    )?;
    for (name, write, delegate) in [("read", false, file_read), ("write", true, file_write)] {
        let state = namespace.clone();
        linker.func_wrap(
            "runtime_proc",
            name,
            move |mut caller: Caller<'_, Host>, fd: i32, ptr: i32, len: i32| -> Result<i32> {
                let memory = memory(&mut caller)?;
                let Some(bytes) = span(memory.len(&caller), ptr, len as u32 as usize) else {
                    return Ok(FAULT);
                };
                let mut state = state.lock().unwrap();
                state.initialize(&mut caller)?;
                if let Some(&actual) = state.files.get(&fd) {
                    caller.data().cancel.check()?;
                    return file_io(
                        &mut caller,
                        &delegate,
                        poll_scratch,
                        memory,
                        actual,
                        bytes,
                        write,
                    );
                }
                if write {
                    memory.view(&mut caller, &[bytes], |data, host| {
                        host.processes.write(fd, data[0])
                    })
                } else {
                    memory.fill(&mut caller, bytes, |data, host| {
                        host.processes.read(fd, data)
                    })
                }
                .context("validated runtime_proc buffer")
            },
        )?;
    }
    let state = namespace.clone();
    linker.func_wrap(
        "runtime_proc",
        "poll",
        move |mut caller: Caller<'_, Host>,
              input: i32,
              count: i32,
              timeout: i32,
              output: i32|
              -> Result<i32> {
            let memory = memory(&mut caller)?;
            let Some(length) = (count as u32 as usize).checked_mul(16) else {
                return Ok(FAULT);
            };
            let size = memory.len(&caller);
            let (Some(input), Some(output)) =
                (span(size, input, length), span(size, output, length))
            else {
                return Ok(FAULT);
            };
            let subscriptions = memory
                .read(&caller, input)
                .context("validated subscriptions")?;
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            match caller
                .data()
                .processes
                .poll_with_files(&subscriptions, timeout, |fd| state.files.contains_key(&fd))
            {
                Ok(events) => {
                    memory
                        .write(&mut caller, output.start, &events)
                        .context("validated events")?;
                    Ok((events.len() / 16) as i32)
                }
                Err(error) => Ok(error),
            }
        },
    )?;
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
            let Some(output) = span(memory.len(&caller), out, 4) else {
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
            let opened = memory
                .read(&caller, output.clone())
                .context("validated descriptor output")?;
            let opened = i32::from_le_bytes(opened.try_into().unwrap());
            let name = span(memory.len(&caller), path, length as u32 as usize)
                .and_then(|range| memory.read(&caller, range));
            if let Some(opened_path) = opened_path(&state, actual, name) {
                state.paths.insert(opened, opened_path);
            }
            state.files.insert(external, opened);
            caller.data_mut().processes.reserve_file(external);
            store_word(&memory, &mut caller, output.start, external as u32)?;
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
            // Like Waffle, every non-preopen (open or closed) returns EBADF.
            // wasi-libc terminates at EBADF and aborts on every other errno.
            if !state.preopens.contains(&fd) {
                return Ok(-BADF);
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
            let Some(at) = span(memory.len(&caller), out, 24) else {
                return Ok(-FAULT);
            };
            let mut output = [0; 24];
            output[0] = if terminal { 2 } else { 0 };
            output[8..16].copy_from_slice(&rights.to_le_bytes());
            memory
                .write(&mut caller, at.start, &output)
                .context("validated fdstat")?;
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
            let Some(at) = span(memory.len(&caller), out, 64) else {
                return Ok(-FAULT);
            };
            let mut output = [0; 64];
            output[16] = if terminal { 2 } else { 0 };
            output[24..32].copy_from_slice(&1u64.to_le_bytes());
            memory
                .write(&mut caller, at.start, &output)
                .context("validated filestat")?;
            Ok(0)
        },
    )?;
    install_watches(linker, &namespace)?;
    linker.allow_shadowing(false);
    Ok(())
}

/// The host path a successful `path_open` names: its directory's path joined with the guest path.
fn opened_path(state: &Namespace, directory: i32, name: Option<Vec<u8>>) -> Option<PathBuf> {
    let base = state.paths.get(&directory)?;
    Some(base.join(std::str::from_utf8(&name?).ok()?))
}

/// Waffle's `runtime_fs` guest filesystem watches (positive WASI errnos, process-local ids).
fn install_watches(linker: &mut Linker<Host>, namespace: &Arc<Mutex<Namespace>>) -> Result<()> {
    use crate::fs_watch::{BADF, FAULT, INVAL, NOBUFS, Read};
    let state = namespace.clone();
    linker.func_wrap(
        "runtime_fs",
        "watch_open",
        move |mut caller: Caller<'_, Host>, fd: i32, flags: i32, out: i32| -> Result<i32> {
            let memory = memory(&mut caller)?;
            let Some(output) = span(memory.len(&caller), out, 4) else {
                return Ok(FAULT);
            };
            if flags as u32 & !1 != 0 {
                return Ok(INVAL);
            }
            let mut state = state.lock().unwrap();
            state.initialize(&mut caller)?;
            // Pipes and terminals are runtime_proc streams, not files or directories.
            if caller.data().processes.owns(fd) {
                return Ok(INVAL);
            }
            let Some(&actual) = state.files.get(&fd) else {
                return Ok(BADF);
            };
            let Some(path) = state.paths.get(&actual).cloned() else {
                return Ok(INVAL);
            };
            drop(state);
            match caller.data_mut().watches.open(&path, flags & 1 != 0) {
                Ok(id) => {
                    store_word(&memory, &mut caller, output.start, id)?;
                    Ok(0)
                }
                Err(errno) => Ok(errno),
            }
        },
    )?;
    linker.func_wrap(
        "runtime_fs",
        "watch_read",
        |mut caller: Caller<'_, Host>, id: i32, buf: i32, len: i32, out: i32| -> Result<i32> {
            let memory = memory(&mut caller)?;
            let size = memory.len(&caller);
            let (Some(buffer), Some(output)) =
                (span(size, buf, len as u32 as usize), span(size, out, 4))
            else {
                return Ok(FAULT);
            };
            let (errno, written) = match caller.data_mut().watches.read(id as u32, buffer.len()) {
                Read::Records(bytes) => {
                    memory
                        .write(&mut caller, buffer.start, &bytes)
                        .context("validated watch buffer")?;
                    (0, bytes.len() as u32)
                }
                Read::Short(needed) => (NOBUFS, needed),
                Read::Errno(errno) => return Ok(errno),
            };
            store_word(&memory, &mut caller, output.start, written)?;
            Ok(errno)
        },
    )?;
    linker.func_wrap(
        "runtime_fs",
        "watch_close",
        |mut caller: Caller<'_, Host>, id: i32| -> i32 {
            caller.data_mut().watches.close(id as u32)
        },
    )?;
    Ok(())
}
