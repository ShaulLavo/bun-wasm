//! Installs the host functions into bun.wasm's slot table
//! (docs/host-abi.md, "Why not plain imports"), and the thin wrappers that
//! move bytes between guest memory and [`crate::net::Net`].

#[cfg(test)]
mod tests;

use std::ops::Range;

use anyhow::{Context, Result, bail};
use wasmtime::{AsContextMut, Caller, Func, Instance, Linker, Store, Val};

use crate::Host;
use crate::guest::GuestMemory;
use crate::net::{ErrorInfo, Output};

const ABI_VERSION: u32 = 2;
const SLOT_NAMES: [&str; 18] = [
    "poll",
    "fetch",
    "fetch_head",
    "read",
    "write",
    "close",
    "listen",
    "local_port",
    "accept",
    "connect",
    "error",
    "peer_addr",
    "shutdown",
    "local_addr",
    "lookup_start",
    "lookup_head",
    "listen_path",
    "connect_path",
];

/// Fills the networking slot table. Generic guests without the export run
/// without the optional networking ABI.
pub fn install(store: &mut Store<Host>, instance: &Instance) -> Result<()> {
    let Ok(slots_fn) = instance.get_typed_func::<(), i32>(&mut *store, "bun_wasm_host_slots")
    else {
        trace(
            store.data(),
            format_args!("no bun_wasm_host_slots export; networking disabled"),
        );
        return Ok(());
    };
    let memory = store
        .data()
        .memory
        .clone()
        .context("bun.wasm exports no memory")?;

    let base = slots_fn.call(&mut *store, ())? as u32 as usize;
    let header = memory
        .read(&*store, base..base + 8)
        .context("slot table pointer out of bounds")?;
    let version = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let count = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    if version != ABI_VERSION || count != SLOT_NAMES.len() {
        bail!(
            "bun.wasm host slot table must be ABI v{ABI_VERSION} with {} slots; got v{version} with {count}",
            SLOT_NAMES.len()
        );
    }

    let funcs = functions(store);
    for (slot, func) in funcs.into_iter().enumerate().take(count) {
        // `grow` returns the old size, which is the new element's index.
        let index = u32::MAX;
        store.data_mut().functions.push(func);
        let at = base + 8 + 4 * slot;
        memory
            .write(&mut *store, at, &index.to_le_bytes())
            .context("slot out of bounds")?;
        trace(
            store.data(),
            format_args!("slot {slot} {} = table[{index}]", SLOT_NAMES[slot]),
        );
    }
    Ok(())
}

fn trace(host: &Host, message: std::fmt::Arguments) {
    if host.trace {
        eprintln!("[bun_wasm] {message}");
    }
}

/// Byte range `ptr..ptr+len` of a guest memory of `size` bytes, or a trap if it's out of bounds.
fn range(size: usize, ptr: i32, len: i32) -> Result<Range<usize>> {
    let (start, len) = (ptr as u32 as usize, len.max(0) as usize);
    let end = start.checked_add(len).filter(|&end| end <= size);
    match end {
        Some(end) => Ok(start..end),
        None => bail!("bun_wasm host call: buffer {start:#x}+{len} out of bounds"),
    }
}

fn proc_range(size: usize, ptr: i32, len: i32) -> Option<Range<usize>> {
    let start = ptr as u32 as usize;
    let end = start.checked_add(len as u32 as usize)?;
    (end <= size).then_some(start..end)
}

/// The calling guest's memory (private or a memory group's) and its current size.
fn guest(caller: &mut Caller<'_, Host>) -> Result<(GuestMemory, usize)> {
    let memory = crate::process::wasi::memory(caller)?;
    let size = memory.len(&*caller);
    Ok((memory, size))
}

/// Borrow (private) or copy (shared) the bytes of validated `ranges` beside the host state.
fn view<R>(
    caller: &mut Caller<'_, Host>,
    memory: &GuestMemory,
    ranges: &[Range<usize>],
    f: impl FnOnce(&[&[u8]], &mut Host) -> R,
) -> Result<R> {
    memory
        .view(caller, ranges, f)
        .context("validated guest range")
}

/// The `(handle, buf, cap) -> len` protocol: write the bytes only if they fit,
/// always return the full length.
fn put(
    memory: &GuestMemory,
    store: impl AsContextMut,
    ptr: i32,
    cap: i32,
    output: Output,
) -> Result<i32> {
    match output {
        Output::Code(code) => Ok(code),
        Output::Bytes(bytes) => {
            if bytes.len() <= cap.max(0) as usize {
                let at = range(memory.len(store.as_context()), ptr, bytes.len() as i32)?;
                memory
                    .write(store, at.start, &bytes)
                    .context("validated output range")?;
            }
            Ok(bytes.len() as i32)
        }
    }
}

/// Store little-endian words at a validated guest offset.
fn put_words(
    memory: &GuestMemory,
    store: impl AsContextMut,
    at: usize,
    words: &[i32],
) -> Result<()> {
    let bytes: Vec<u8> = words.iter().flat_map(|word| word.to_le_bytes()).collect();
    memory
        .write(store, at, &bytes)
        .context("validated output words")
}

fn text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() > 300 {
        format!("{}…", &text[..text.floor_char_boundary(300)])
    } else {
        text.into_owned()
    }
}

/// Host functions in slot order, with the exact ABI signatures.
fn functions(store: &mut Store<Host>) -> Vec<Func> {
    vec![
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, timeout: i32| -> Result<i32> {
                let host = caller.data_mut();
                host.cancel.check()?;
                let woke = host
                    .net
                    .poll(if timeout < 0 { 25 } else { timeout.min(25) });
                if timeout != 0 || woke != 0 {
                    trace(host, format_args!("poll({timeout}) -> {woke}"));
                }
                Ok(woke)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, meta: i32, meta_len: i32, body: i32, body_len: i32| {
                let (memory, size) = guest(&mut caller)?;
                let ranges = [range(size, meta, meta_len)?, range(size, body, body_len)?];
                view(&mut caller, &memory, &ranges, |parts, host| {
                    let handle = host.net.fetch(parts[0], parts[1]);
                    trace(
                        host,
                        format_args!(
                            "fetch({} metadata bytes, {} body bytes) -> {handle}",
                            parts[0].len(),
                            parts[1].len()
                        ),
                    );
                    handle
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                let (memory, _) = guest(&mut caller)?;
                let host = caller.data_mut();
                let output = host.net.fetch_head(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(
                        host,
                        format_args!("fetch_head({handle}) -> {} metadata bytes", bytes.len()),
                    );
                }
                let n = put(&memory, &mut caller, buf, cap, output)?;
                if n < 0 && n != crate::net::AGAIN {
                    trace(caller.data(), format_args!("fetch_head({handle}) -> {n}"));
                }
                Ok(n)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                let (memory, size) = guest(&mut caller)?;
                let buf = range(size, buf, cap)?;
                let n = memory
                    .fill(&mut caller, buf, |bytes, host| host.net.read(handle, bytes))
                    .context("validated guest range")?;
                if n != crate::net::AGAIN {
                    trace(caller.data(), format_args!("read({handle}, {cap}) -> {n}"));
                }
                Ok(n)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, len: i32| {
                let (memory, size) = guest(&mut caller)?;
                let data = range(size, buf, len)?;
                view(&mut caller, &memory, &[data], |parts, host| {
                    let n = host.net.write(handle, parts[0]);
                    trace(host, format_args!("write({handle}, {len}) -> {n}"));
                    n
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32| -> i32 {
                let host = caller.data_mut();
                let result = host.net.close(handle);
                trace(host, format_args!("close({handle}) -> {result}"));
                result
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, name: i32, name_len: i32, port: i32| {
                let (memory, size) = guest(&mut caller)?;
                let name = range(size, name, name_len)?;
                view(&mut caller, &memory, &[name], |parts, host| {
                    let name = String::from_utf8_lossy(parts[0]).into_owned();
                    let handle = host.net.listen(&name, port);
                    trace(host, format_args!("listen({name:?}, {port}) -> {handle}"));
                    handle
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32| -> i32 {
                let host = caller.data_mut();
                let port = host.net.local_port(handle);
                trace(host, format_args!("local_port({handle}) -> {port}"));
                port
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, listener: i32| -> i32 {
                let host = caller.data_mut();
                let handle = host.net.accept(listener);
                if handle != crate::net::AGAIN {
                    trace(host, format_args!("accept({listener}) -> {handle}"));
                }
                handle
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, name: i32, name_len: i32, port: i32| {
                let (memory, size) = guest(&mut caller)?;
                let name = range(size, name, name_len)?;
                view(&mut caller, &memory, &[name], |parts, host| {
                    let name = String::from_utf8_lossy(parts[0]).into_owned();
                    let handle = host.net.connect(&name, port);
                    trace(host, format_args!("connect({name:?}, {port}) -> {handle}"));
                    handle
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                let (memory, _) = guest(&mut caller)?;
                let host = caller.data_mut();
                let output = host.net.error(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(host, format_args!("error({handle}) -> {}", text(bytes)));
                }
                put(&memory, &mut caller, buf, cap, output)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                let (memory, _) = guest(&mut caller)?;
                let host = caller.data_mut();
                let output = host.net.peer_addr(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(host, format_args!("peer_addr({handle}) -> {}", text(bytes)));
                }
                put(&memory, &mut caller, buf, cap, output)
            },
        ),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32| {
            caller.data_mut().net.shutdown(id)
        }),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, id: i32, buf: i32, cap: i32| {
                let (memory, _) = guest(&mut caller)?;
                let output = caller.data_mut().net.local_addr(id);
                put(&memory, &mut caller, buf, cap, output)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>,
             host_ptr: i32,
             host_len: i32,
             family: i32,
             hints: i32| {
                let (memory, size) = guest(&mut caller)?;
                let hostname = range(size, host_ptr, host_len)?;
                view(&mut caller, &memory, &[hostname], |parts, host| {
                    let hostname = match std::str::from_utf8(parts[0]) {
                        Ok(hostname) => hostname,
                        Err(_) => {
                            let error = ErrorInfo::new(
                                "TypeError",
                                "hostname is not valid UTF-8",
                                Some("EINVAL"),
                            )
                            .with_syscall("getaddrinfo");
                            let handle = host.net.fail(error);
                            trace(
                                host,
                                format_args!(
                                    "lookup_start(<invalid utf-8>, {family}, {hints}) -> {handle}"
                                ),
                            );
                            return handle;
                        }
                    };
                    let handle = host.net.lookup(hostname, family, hints);
                    trace(
                        host,
                        format_args!("lookup_start({hostname:?}, {family}, {hints}) -> {handle}"),
                    );
                    handle
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                let (memory, _) = guest(&mut caller)?;
                let host = caller.data_mut();
                let output = host.net.lookup_head(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(
                        host,
                        format_args!("lookup_head({handle}) -> {} bytes", bytes.len()),
                    );
                }
                put(&memory, &mut caller, buf, cap, output)
            },
        ),
    ]
}

const PROCESS_NAMES: [&str; 11] = [
    "spawn", "job_of", "pipe", "dup", "read", "write", "wait", "wait_job", "kill", "kill_job",
    "poll",
];

fn process_functions(store: &mut Store<Host>) -> Vec<Func> {
    vec![
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, ptr: i32, len: i32| {
                let (memory, size) = guest(&mut caller)?;
                let Some(at) = proc_range(size, ptr, len) else {
                    return Ok(crate::process::FAULT);
                };
                view(&mut caller, &memory, &[at], |parts, host| {
                    host.processes.spawn(parts[0])
                })
            },
        ),
        Func::wrap(&mut *store, |caller: Caller<'_, Host>, pid: i32| {
            caller.data().processes.job_of(pid)
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, out: i32| {
            let (memory, size) = guest(&mut caller)?;
            let Some(at) = proc_range(size, out, 8) else {
                return Ok(crate::process::FAULT);
            };
            match caller.data_mut().processes.pipe() {
                Ok(ends) => {
                    put_words(&memory, &mut caller, at.start, &ends)?;
                    Ok(0)
                }
                Err(error) => Ok(error),
            }
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, fd: i32| {
            caller.data_mut().processes.dup(fd)
        }),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, fd: i32, ptr: i32, len: i32| {
                let (memory, size) = guest(&mut caller)?;
                let Some(at) = proc_range(size, ptr, len) else {
                    return Ok(crate::process::FAULT);
                };
                memory
                    .fill(&mut caller, at, |bytes, host| {
                        host.processes.read(fd, bytes)
                    })
                    .context("validated guest range")
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, fd: i32, ptr: i32, len: i32| {
                let (memory, size) = guest(&mut caller)?;
                let Some(at) = proc_range(size, ptr, len) else {
                    return Ok(crate::process::FAULT);
                };
                view(&mut caller, &memory, &[at], |parts, host| {
                    host.processes.write(fd, parts[0])
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, pid: i32, out: i32| {
                let (memory, size) = guest(&mut caller)?;
                let Some(at) = proc_range(size, out, 8) else {
                    return Ok(crate::process::FAULT);
                };
                match caller.data_mut().processes.wait(pid) {
                    Ok(outcome) => {
                        let (kind, code) = outcome.wire();
                        put_words(&memory, &mut caller, at.start, &[kind, code])?;
                        Ok(0)
                    }
                    Err(error) => Ok(error),
                }
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, job: i32, flags: i32, out: i32| {
                let (memory, size) = guest(&mut caller)?;
                // Faults never consume a completed job.
                let Some(at) = proc_range(size, out, 8) else {
                    return Ok(crate::process::FAULT);
                };
                match caller.data_mut().processes.wait_job(job, flags) {
                    Ok(outcome) => {
                        let (kind, value) = outcome.wire();
                        put_words(&memory, &mut caller, at.start, &[kind, value])?;
                        Ok(0)
                    }
                    Err(error) => Ok(error),
                }
            },
        ),
        Func::wrap(
            &mut *store,
            |caller: Caller<'_, Host>, pid: i32, signal: i32| {
                caller.data().processes.kill(pid, signal)
            },
        ),
        Func::wrap(
            &mut *store,
            |caller: Caller<'_, Host>, job: i32, signal: i32| {
                caller.data().processes.kill_job(job, signal)
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, ptr: i32, count: i32, timeout: i32, out: i32| {
                let (memory, size) = guest(&mut caller)?;
                let Some(len) = (count as u32)
                    .checked_mul(16)
                    .and_then(|len| i32::try_from(len).ok())
                else {
                    return Ok(crate::process::FAULT);
                };
                let (Some(input), Some(output)) =
                    (proc_range(size, ptr, len), proc_range(size, out, len))
                else {
                    return Ok(crate::process::FAULT);
                };
                let polled = view(&mut caller, &memory, &[input], |parts, host| {
                    host.processes.poll(parts[0], timeout)
                })?;
                match polled {
                    Ok(events) => {
                        memory
                            .write(&mut caller, output.start, &events)
                            .context("validated poll output")?;
                        Ok((events.len() / 16) as i32)
                    }
                    Err(error) => Ok(error),
                }
            },
        ),
    ]
}

/// bash-web's shell guest imports two small namespaces besides runtime_proc. On this host it is
/// never the terminal owner: it reads its inherited stdio, reports 80 columns and owns no phase.
/// The native filesystem has no Waffle inode metadata, so the permission query answers ENOTSUP
/// (docs/host-abi.md "Inode permission query" allows it) and the shell treats access as unknown.
pub fn add_shell_imports(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap("shell_terminal", "inherited_fd", |index: i32| -> i32 {
        if (0..3).contains(&index) { index } else { -1 }
    })?;
    linker.func_wrap("shell_terminal", "columns", || -> i32 { 80 })?;
    linker.func_wrap("shell_terminal", "phase", |_: i32| {})?;
    linker.func_wrap(
        "runtime_fs",
        "path_permissions_get",
        |_: i32, _: i32, _: i32, _: i32, _: i32| -> i32 { 58 },
    )?;
    Ok(())
}

/// Register direct process imports and the networking-only WASI trampoline.
pub fn add_import(linker: &mut Linker<Host>, store: &mut Store<Host>) -> Result<()> {
    for (name, function) in PROCESS_NAMES.into_iter().zip(process_functions(store)) {
        linker.define(&mut *store, "runtime_proc", name, function)?;
    }
    linker.func_wrap(
        "runtime_proc",
        "start_status",
        |caller: Caller<'_, Host>, pid: i32| -> Result<i32> {
            caller.data().cancel.check()?;
            Ok(caller.data().processes.start_status(pid))
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "access_start",
        |mut caller: Caller<'_, Host>,
         path: i32,
         path_len: i32,
         cwd: i32,
         cwd_len: i32,
         mode: i32| {
            if mode != 1 {
                return Ok(crate::process::INVAL);
            }
            let (memory, size) = guest(&mut caller)?;
            let (Some(path), Some(cwd)) = (
                proc_range(size, path, path_len),
                proc_range(size, cwd, cwd_len),
            ) else {
                return Ok(crate::process::FAULT);
            };
            view(&mut caller, &memory, &[path, cwd], |parts, host| {
                let (Ok(path), Ok(cwd)) =
                    (std::str::from_utf8(parts[0]), std::str::from_utf8(parts[1]))
                else {
                    return crate::process::INVAL;
                };
                host.processes.access_start(path, cwd, mode)
            })
        },
    )?;
    // Waffle's process-identity import: the full byte count, written only when it fits.
    linker.func_wrap(
        "runtime_proc",
        "cwd",
        |mut caller: Caller<'_, Host>, ptr: i32, len: i32| -> Result<i32> {
            caller.data().cancel.check()?;
            let (memory, size) = guest(&mut caller)?;
            let Some(range) = proc_range(size, ptr, len) else {
                return Ok(crate::process::FAULT);
            };
            let cwd = caller.data().cwd.clone().into_bytes();
            if cwd.len() <= range.len() {
                memory
                    .write(&mut caller, range.start, &cwd)
                    .context("validated cwd output")?;
            }
            Ok(cwd.len() as i32)
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "access_take",
        |mut caller: Caller<'_, Host>, request: i32| {
            caller.data_mut().processes.access_take(request)
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "access_cancel",
        |mut caller: Caller<'_, Host>, request: i32| {
            caller.data_mut().processes.access_cancel(request)
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "signal",
        |caller: Caller<'_, Host>, signal: i32, operation: i32| -> Result<i32> {
            let cancel = &caller.data().cancel;
            let result = cancel.signal(signal, operation);
            cancel.check()?;
            Ok(result)
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "interrupted",
        |caller: Caller<'_, Host>| -> Result<i32> {
            let cancel = &caller.data().cancel;
            cancel.check()?;
            Ok(cancel.signal(0, 0))
        },
    )?;
    linker.func_wrap(
        "runtime_proc",
        "default_signal",
        |caller: Caller<'_, Host>, signal: i32| -> Result<i32> {
            if let Err(error) = crate::process::validate_signal(signal, false) {
                return Ok(error);
            }
            if matches!(signal, 17 | 18 | 23 | 28) {
                return Ok(0);
            }
            let cancel = &caller.data().cancel;
            cancel.select(crate::process::FinalOutcome::Signal(signal));
            cancel.check()?;
            Ok(0)
        },
    )?;
    crate::process::wasi::install(linker, store)?;
    linker.allow_shadowing(true);
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "sock_send",
        |mut caller: Caller<'_, Host>,
         fd: i32,
         packet: i32,
         count: i32,
         _flags: i32,
         out: i32|
         -> Result<i32> {
            if fd != 0x7fff_b0b0 || count != 5 {
                return Ok(58);
            }
            let (memory, size) = guest(&mut caller)?;
            let bytes = memory
                .read(&caller, range(size, packet, 20)?)
                .context("validated packet")?;
            let words: Vec<i32> = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| i32::from_le_bytes(*b))
                .collect();
            let Some(func) = caller.data().functions.get(words[0] as usize).copied() else {
                return Ok(58);
            };
            let count = func.ty(&caller).params().len();
            let args: Vec<Val> = words[1..1 + count].iter().map(|&n| Val::I32(n)).collect();
            let mut result = [Val::I32(-4)];
            func.call(&mut caller, &args, &mut result)?;
            memory
                .write(
                    &mut caller,
                    out as u32 as usize,
                    &result[0].unwrap_i32().to_le_bytes(),
                )
                .context("bun_wasm host call: result out of bounds")?;
            Ok(0)
        },
    )?;
    Ok(())
}
