//! Installs the host functions into bun.wasm's slot table
//! (docs/host-abi.md, "Why not plain imports"), and the thin wrappers that
//! move bytes between guest memory and [`crate::net::Net`].

#[cfg(test)]
mod tests;

use std::ops::Range;

use anyhow::{Context, Result, bail};
use wasmtime::{Caller, Func, Instance, Linker, Store, Val};

use crate::Host;
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
    let memory = store.data().memory.context("bun.wasm exports no memory")?;

    let base = slots_fn.call(&mut *store, ())? as u32 as usize;
    let header = memory
        .data(&*store)
        .get(base..base + 8)
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
            .data_mut(&mut *store)
            .get_mut(at..at + 4)
            .context("slot out of bounds")?
            .copy_from_slice(&index.to_le_bytes());
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

/// Byte range `ptr..ptr+len` of guest memory, or a trap if it's out of bounds.
fn range(memory: &[u8], ptr: i32, len: i32) -> Result<Range<usize>> {
    let (start, len) = (ptr as u32 as usize, len.max(0) as usize);
    let end = start.checked_add(len).filter(|&end| end <= memory.len());
    match end {
        Some(end) => Ok(start..end),
        None => bail!("bun_wasm host call: buffer {start:#x}+{len} out of bounds"),
    }
}

fn proc_range(memory: &[u8], ptr: i32, len: i32) -> Option<Range<usize>> {
    let start = ptr as u32 as usize;
    let end = start.checked_add(len as u32 as usize)?;
    (end <= memory.len()).then_some(start..end)
}

/// Runs `f` with guest memory and the host state borrowed together.
fn with_memory<R>(
    caller: &mut Caller<'_, Host>,
    f: impl FnOnce(&mut [u8], &mut Host) -> Result<R>,
) -> Result<R> {
    let memory = crate::process::wasi::memory(caller)?;
    let (memory, host) = memory.data_and_store_mut(caller);
    f(memory, host)
}

/// The `(handle, buf, cap) -> len` protocol: write the bytes only if they fit,
/// always return the full length.
fn put(memory: &mut [u8], ptr: i32, cap: i32, output: Output) -> Result<i32> {
    match output {
        Output::Code(code) => Ok(code),
        Output::Bytes(bytes) => {
            if bytes.len() <= cap.max(0) as usize {
                let at = range(memory, ptr, bytes.len() as i32)?;
                memory[at].copy_from_slice(&bytes);
            }
            Ok(bytes.len() as i32)
        }
    }
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
                with_memory(&mut caller, |memory, host| {
                    let meta = &memory[range(memory, meta, meta_len)?];
                    let body = &memory[range(memory, body, body_len)?];
                    let handle = host.net.fetch(meta, body);
                    trace(
                        host,
                        format_args!(
                            "fetch({} metadata bytes, {} body bytes) -> {handle}",
                            meta.len(),
                            body.len()
                        ),
                    );
                    Ok(handle)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    let output = host.net.fetch_head(handle);
                    if let Output::Bytes(bytes) = &output {
                        trace(
                            host,
                            format_args!("fetch_head({handle}) -> {} metadata bytes", bytes.len()),
                        );
                    }
                    let n = put(memory, buf, cap, output)?;
                    if n < 0 && n != crate::net::AGAIN {
                        trace(host, format_args!("fetch_head({handle}) -> {n}"));
                    }
                    Ok(n)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    let buf = range(memory, buf, cap)?;
                    let n = host.net.read(handle, &mut memory[buf]);
                    if n != crate::net::AGAIN {
                        trace(host, format_args!("read({handle}, {cap}) -> {n}"));
                    }
                    Ok(n)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, len: i32| {
                with_memory(&mut caller, |memory, host| {
                    let data = &memory[range(memory, buf, len)?];
                    let n = host.net.write(handle, data);
                    trace(host, format_args!("write({handle}, {len}) -> {n}"));
                    Ok(n)
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
                with_memory(&mut caller, |memory, host| {
                    let name = String::from_utf8_lossy(&memory[range(memory, name, name_len)?])
                        .into_owned();
                    let handle = host.net.listen(&name, port);
                    trace(host, format_args!("listen({name:?}, {port}) -> {handle}"));
                    Ok(handle)
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
                with_memory(&mut caller, |memory, host| {
                    let name = String::from_utf8_lossy(&memory[range(memory, name, name_len)?])
                        .into_owned();
                    let handle = host.net.connect(&name, port);
                    trace(host, format_args!("connect({name:?}, {port}) -> {handle}"));
                    Ok(handle)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    let output = host.net.error(handle);
                    if let Output::Bytes(bytes) = &output {
                        trace(host, format_args!("error({handle}) -> {}", text(bytes)));
                    }
                    put(memory, buf, cap, output)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    let output = host.net.peer_addr(handle);
                    if let Output::Bytes(bytes) = &output {
                        trace(host, format_args!("peer_addr({handle}) -> {}", text(bytes)));
                    }
                    put(memory, buf, cap, output)
                })
            },
        ),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32| {
            caller.data_mut().net.shutdown(id)
        }),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, id: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    put(memory, buf, cap, host.net.local_addr(id))
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>,
             host_ptr: i32,
             host_len: i32,
             family: i32,
             hints: i32| {
                with_memory(&mut caller, |memory, host| {
                    let hostname = match std::str::from_utf8(
                        &memory[range(memory, host_ptr, host_len)?],
                    ) {
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
                            return Ok(handle);
                        }
                    };
                    let handle = host.net.lookup(hostname, family, hints);
                    trace(
                        host,
                        format_args!("lookup_start({hostname:?}, {family}, {hints}) -> {handle}"),
                    );
                    Ok(handle)
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
                with_memory(&mut caller, |memory, host| {
                    let output = host.net.lookup_head(handle);
                    if let Output::Bytes(bytes) = &output {
                        trace(
                            host,
                            format_args!("lookup_head({handle}) -> {} bytes", bytes.len()),
                        );
                    }
                    put(memory, buf, cap, output)
                })
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
                with_memory(&mut caller, |memory, host| {
                    let Some(at) = proc_range(memory, ptr, len) else {
                        return Ok(crate::process::FAULT);
                    };
                    Ok(host.processes.spawn(&memory[at]))
                })
            },
        ),
        Func::wrap(&mut *store, |caller: Caller<'_, Host>, pid: i32| {
            caller.data().processes.job_of(pid)
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, out: i32| {
            with_memory(&mut caller, |memory, host| {
                let Some(at) = proc_range(memory, out, 8) else {
                    return Ok(crate::process::FAULT);
                };
                match host.processes.pipe() {
                    Ok(ends) => {
                        for (word, fd) in memory[at].as_chunks_mut::<4>().0.iter_mut().zip(ends) {
                            word.copy_from_slice(&fd.to_le_bytes());
                        }
                        Ok(0)
                    }
                    Err(error) => Ok(error),
                }
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, fd: i32| {
            caller.data_mut().processes.dup(fd)
        }),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, fd: i32, ptr: i32, len: i32| {
                with_memory(&mut caller, |memory, host| {
                    let Some(at) = proc_range(memory, ptr, len) else {
                        return Ok(crate::process::FAULT);
                    };
                    Ok(host.processes.read(fd, &mut memory[at]))
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, fd: i32, ptr: i32, len: i32| {
                with_memory(&mut caller, |memory, host| {
                    let Some(at) = proc_range(memory, ptr, len) else {
                        return Ok(crate::process::FAULT);
                    };
                    Ok(host.processes.write(fd, &memory[at]))
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, pid: i32, out: i32| {
                with_memory(&mut caller, |memory, host| {
                    let Some(at) = proc_range(memory, out, 8) else {
                        return Ok(crate::process::FAULT);
                    };
                    match host.processes.wait(pid) {
                        Ok(outcome) => {
                            let (kind, code) = outcome.wire();
                            let bytes = &mut memory[at];
                            bytes[..4].copy_from_slice(&kind.to_le_bytes());
                            bytes[4..].copy_from_slice(&code.to_le_bytes());
                            Ok(0)
                        }
                        Err(error) => Ok(error),
                    }
                })
            },
        ),
        Func::wrap(
            &mut *store,
            |mut caller: Caller<'_, Host>, job: i32, flags: i32, out: i32| {
                with_memory(&mut caller, |memory, host| {
                    // Faults never consume a completed job.
                    let Some(at) = proc_range(memory, out, 8) else {
                        return Ok(crate::process::FAULT);
                    };
                    match host.processes.wait_job(job, flags) {
                        Ok(outcome) => {
                            let (kind, value) = outcome.wire();
                            memory[at.clone()][..4].copy_from_slice(&kind.to_le_bytes());
                            memory[at][4..].copy_from_slice(&value.to_le_bytes());
                            Ok(0)
                        }
                        Err(error) => Ok(error),
                    }
                })
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
                with_memory(&mut caller, |memory, host| {
                    let Some(len) = (count as u32)
                        .checked_mul(16)
                        .and_then(|len| i32::try_from(len).ok())
                    else {
                        return Ok(crate::process::FAULT);
                    };
                    let (Some(input), Some(output)) =
                        (proc_range(memory, ptr, len), proc_range(memory, out, len))
                    else {
                        return Ok(crate::process::FAULT);
                    };
                    match host.processes.poll(&memory[input], timeout) {
                        Ok(events) => {
                            let count = events.len() / 16;
                            memory[output.start..output.start + events.len()]
                                .copy_from_slice(&events);
                            Ok(count as i32)
                        }
                        Err(error) => Ok(error),
                    }
                })
            },
        ),
    ]
}

/// bash-web's shell guest imports two small namespaces besides runtime_proc. On this host it is
/// never the terminal owner: it reads inherited stdio, reports 80x24 geometry and owns no phase.
/// The native filesystem has no Waffle inode metadata, so the permission query answers ENOTSUP
/// (docs/host-abi.md "Inode permission query" allows it) and the shell treats access as unknown.
pub fn add_shell_imports(linker: &mut Linker<Host>) -> Result<()> {
    linker.func_wrap("shell_terminal", "inherited_fd", |index: i32| -> i32 {
        if (0..3).contains(&index) { index } else { -1 }
    })?;
    linker.func_wrap("shell_terminal", "columns", || -> i32 { 80 })?;
    linker.func_wrap("shell_terminal", "rows", || -> i32 { 24 })?;
    linker.func_wrap("shell_terminal", "phase", |_: i32, _: i32| {})?;
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
        "inherited_fd",
        |caller: Caller<'_, Host>, index: u32| -> Result<i32> {
            caller.data().cancel.check()?;
            Ok(caller.data().processes.inherited_fd(index))
        },
    )?;
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
            with_memory(&mut caller, |memory, host| {
                let (Some(path), Some(cwd)) = (
                    proc_range(memory, path, path_len),
                    proc_range(memory, cwd, cwd_len),
                ) else {
                    return Ok(crate::process::FAULT);
                };
                let (Ok(path), Ok(cwd)) = (
                    std::str::from_utf8(&memory[path]),
                    std::str::from_utf8(&memory[cwd]),
                ) else {
                    return Ok(crate::process::INVAL);
                };
                Ok(host.processes.access_start(path, cwd, mode))
            })
        },
    )?;
    // Waffle's process-identity import: the full byte count, written only when it fits.
    linker.func_wrap(
        "runtime_proc",
        "cwd",
        |mut caller: Caller<'_, Host>, ptr: i32, len: i32| -> Result<i32> {
            caller.data().cancel.check()?;
            with_memory(&mut caller, |memory, host| {
                let Some(range) = proc_range(memory, ptr, len) else {
                    return Ok(crate::process::FAULT);
                };
                let cwd = host.cwd.as_bytes();
                if cwd.len() <= range.len() {
                    memory[range.start..range.start + cwd.len()].copy_from_slice(cwd);
                }
                Ok(cwd.len() as i32)
            })
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
            let memory = crate::process::wasi::memory(&mut caller)?;
            let bytes = &memory.data(&caller)[range(memory.data(&caller), packet, 20)?];
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
            memory.write(
                &mut caller,
                out as u32 as usize,
                &result[0].unwrap_i32().to_le_bytes(),
            )?;
            Ok(0)
        },
    )?;
    Ok(())
}
