//! Installs the host functions into bun.wasm's slot table
//! (docs/host-abi.md, "Why not plain imports"), and the thin wrappers that
//! move bytes between guest memory and [`crate::net::Net`].

use std::ops::Range;

use anyhow::{Context, Result, bail};
use wasmtime::{Caller, Func, Instance, Linker, Store, Val};

use crate::Host;
use crate::net::Output;

const ABI_VERSION: u32 = 1;
const SLOT_NAMES: [&str; 19] = [
    "poll", "fetch", "fetch_head", "read", "write", "close", "listen", "local_port", "accept", "connect", "error",
    "peer_addr", "spawn", "child_wait", "child_pipe", "child_kill", "shutdown", "local_addr", "signal",
];

/// Fills the guest's slot table. A bun.wasm without the export (older
/// builds) just runs without networking.
pub fn install(store: &mut Store<Host>, instance: &Instance) -> Result<()> {
    let Ok(slots_fn) = instance.get_typed_func::<(), i32>(&mut *store, "bun_wasm_host_slots") else {
        trace(store.data(), format_args!("no bun_wasm_host_slots export; networking disabled"));
        return Ok(());
    };
    let memory = store.data().memory.context("bun.wasm exports no memory")?;

    let base = slots_fn.call(&mut *store, ())? as u32 as usize;
    let header = memory.data(&*store).get(base..base + 8).context("slot table pointer out of bounds")?;
    let version = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let count = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
    if version != ABI_VERSION {
        eprintln!("bun-wasm: bun.wasm speaks host ABI v{version}, this launcher v{ABI_VERSION}; networking disabled");
        return Ok(());
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
        trace(store.data(), format_args!("slot {slot} {} = table[{index}]", SLOT_NAMES[slot]));
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

/// Runs `f` with guest memory and the host state borrowed together.
fn with_memory<R>(caller: &mut Caller<'_, Host>, f: impl FnOnce(&mut [u8], &mut Host) -> Result<R>) -> Result<R> {
    let memory = caller.data().memory.context("bun.wasm exports no memory")?;
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
    if text.len() > 300 { format!("{}…", &text[..text.floor_char_boundary(300)]) } else { text.into_owned() }
}

/// Host functions in slot order, with the exact ABI signatures.
fn functions(store: &mut Store<Host>) -> Vec<Func> {
    vec![
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, timeout: i32| -> Result<i32> {
            let host = caller.data_mut();
            host.cancel.check()?;
            let woke = host.net.poll(if timeout < 0 { 25 } else { timeout.min(25) });
            if timeout != 0 || woke != 0 {
                trace(host, format_args!("poll({timeout}) -> {woke}"));
            }
            Ok(woke)
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, meta: i32, meta_len: i32, body: i32, body_len: i32| {
            with_memory(&mut caller, |memory, host| {
                let meta = &memory[range(memory, meta, meta_len)?];
                let body = &memory[range(memory, body, body_len)?];
                let handle = host.net.fetch(meta, body);
                trace(host, format_args!("fetch({}, {} body bytes) -> {handle}", text(meta), body.len()));
                Ok(handle)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
            with_memory(&mut caller, |memory, host| {
                let output = host.net.fetch_head(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(host, format_args!("fetch_head({handle}) -> {}", text(bytes)));
                }
                let n = put(memory, buf, cap, output)?;
                if n < 0 && n != crate::net::AGAIN {
                    trace(host, format_args!("fetch_head({handle}) -> {n}"));
                }
                Ok(n)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
            with_memory(&mut caller, |memory, host| {
                let buf = range(memory, buf, cap)?;
                let n = if handle == 0 || handle >= crate::process::FIRST_HANDLE { host.processes.read(handle, &mut memory[buf]) } else { host.net.read(handle, &mut memory[buf]) };
                if n != crate::net::AGAIN {
                    trace(host, format_args!("read({handle}, {cap}) -> {n}"));
                }
                Ok(n)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, len: i32| {
            with_memory(&mut caller, |memory, host| {
                let data = &memory[range(memory, buf, len)?];
                let n = if handle >= crate::process::FIRST_HANDLE { host.processes.write(handle, data) } else { host.net.write(handle, data) };
                trace(host, format_args!("write({handle}, {len}) -> {n}"));
                Ok(n)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32| -> i32 {
            let host = caller.data_mut();
            let result = if handle >= crate::process::FIRST_HANDLE { host.processes.close(handle) } else { host.net.close(handle) };
            trace(host, format_args!("close({handle}) -> {result}"));
            result
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, name: i32, name_len: i32, port: i32| {
            with_memory(&mut caller, |memory, host| {
                let name = String::from_utf8_lossy(&memory[range(memory, name, name_len)?]).into_owned();
                let handle = host.net.listen(&name, port);
                trace(host, format_args!("listen({name:?}, {port}) -> {handle}"));
                Ok(handle)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32| -> i32 {
            let host = caller.data_mut();
            let port = host.net.local_port(handle);
            trace(host, format_args!("local_port({handle}) -> {port}"));
            port
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, listener: i32| -> i32 {
            let host = caller.data_mut();
            let handle = host.net.accept(listener);
            if handle != crate::net::AGAIN {
                trace(host, format_args!("accept({listener}) -> {handle}"));
            }
            handle
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, name: i32, name_len: i32, port: i32| {
            with_memory(&mut caller, |memory, host| {
                let name = String::from_utf8_lossy(&memory[range(memory, name, name_len)?]).into_owned();
                let handle = host.net.connect(&name, port);
                trace(host, format_args!("connect({name:?}, {port}) -> {handle}"));
                Ok(handle)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
            with_memory(&mut caller, |memory, host| {
                let output = if handle >= crate::process::FIRST_HANDLE { host.processes.error(handle) } else { host.net.error(handle) };
                if let Output::Bytes(bytes) = &output {
                    trace(host, format_args!("error({handle}) -> {}", text(bytes)));
                }
                put(memory, buf, cap, output)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, cap: i32| {
            with_memory(&mut caller, |memory, host| {
                let output = host.net.peer_addr(handle);
                if let Output::Bytes(bytes) = &output {
                    trace(host, format_args!("peer_addr({handle}) -> {}", text(bytes)));
                }
                put(memory, buf, cap, output)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, meta: i32, len: i32| {
            with_memory(&mut caller, |memory, host| {
                let meta = &memory[range(memory, meta, len)?];
                Ok(match host.processes.spawn(meta) {
                    Ok(id) => id,
                    Err(error) => host.net.fail(error),
                })
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32| caller.data_mut().processes.wait(id)),
        Func::wrap(&mut *store, |caller: Caller<'_, Host>, id: i32, fd: i32| caller.data().processes.child_pipe(id, fd)),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32, signal: i32| caller.data_mut().processes.kill(id, signal)),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32| caller.data_mut().net.shutdown(id)),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, id: i32, buf: i32, cap: i32| {
            with_memory(&mut caller, |memory, host| put(memory, buf, cap, host.net.local_addr(id)))
        }),
        Func::wrap(&mut *store, |caller: Caller<'_, Host>, signal: i32, operation: i32| -> Result<i32> {
            let cancel = &caller.data().cancel;
            let result = cancel.signal(signal, operation);
            // A self-raise or pending-handler removal can select default death.
            // Stop this guest call now; its typed outcome was already sealed.
            cancel.check()?;
            Ok(result)
        }),
    ]
}

/// Dispatch the optional ABI through an existing WASI import, avoiding cross-module tables.
pub fn add_import(linker: &mut Linker<Host>) -> Result<()> {
    linker.allow_shadowing(true);
    linker.func_wrap("wasi_snapshot_preview1", "sock_send", |mut caller: Caller<'_, Host>, fd: i32, packet: i32, count: i32, _flags: i32, out: i32| -> Result<i32> {
        if fd != 0x7fff_b0b0 || count != 5 { return Ok(58); }
        let memory = caller.data().memory.context("no memory")?;
        let bytes = &memory.data(&caller)[range(memory.data(&caller), packet, 20)?];
        let words: Vec<i32> = bytes.chunks_exact(4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).collect();
        let Some(func) = caller.data().functions.get(words[0] as usize).copied() else { return Ok(58); };
        let count = func.ty(&caller).params().len();
        let args: Vec<Val> = words[1..1 + count].iter().map(|&n| Val::I32(n)).collect();
        let mut result = [Val::I32(-4)];
        func.call(&mut caller, &args, &mut result)?;
        memory.write(&mut caller, out as u32 as usize, &result[0].unwrap_i32().to_le_bytes())?;
        Ok(0)
    })?;
    Ok(())
}
