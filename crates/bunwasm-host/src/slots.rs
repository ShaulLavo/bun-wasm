//! Installs the host functions into bun.wasm's slot table
//! (docs/host-abi.md, "Why not plain imports"), and the thin wrappers that
//! move bytes between guest memory and [`crate::net::Net`].

use std::ops::Range;

use anyhow::{Context, Result, bail};
use wasmtime::{Caller, Func, Instance, Ref, Store};

use crate::Host;
use crate::net::Output;

const ABI_VERSION: u32 = 1;
const SLOT_NAMES: [&str; 12] = [
    "poll", "fetch", "fetch_head", "read", "write", "close", "listen", "local_port", "accept", "connect", "error",
    "peer_addr",
];

/// Fills the guest's slot table. A bun.wasm without the export (older
/// builds) just runs without networking.
pub fn install(store: &mut Store<Host>, instance: &Instance) -> Result<()> {
    let Ok(slots_fn) = instance.get_typed_func::<(), i32>(&mut *store, "bun_wasm_host_slots") else {
        trace(store.data(), format_args!("no bun_wasm_host_slots export; networking disabled"));
        return Ok(());
    };
    let table = instance
        .get_table(&mut *store, "__indirect_function_table")
        .context("bun.wasm exports bun_wasm_host_slots but not __indirect_function_table")?;
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
        let index = table.grow(&mut *store, 1, Ref::Func(Some(func)))? as u32;
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

/// The 12 host functions, in slot order, with the exact ABI signatures.
fn functions(store: &mut Store<Host>) -> Vec<Func> {
    vec![
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, timeout: i32| -> i32 {
            let host = caller.data_mut();
            let woke = host.net.poll(timeout);
            if timeout != 0 || woke != 0 {
                trace(host, format_args!("poll({timeout}) -> {woke}"));
            }
            woke
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
                let n = host.net.read(handle, &mut memory[buf]);
                if n != crate::net::AGAIN {
                    trace(host, format_args!("read({handle}, {cap}) -> {n}"));
                }
                Ok(n)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32, buf: i32, len: i32| {
            with_memory(&mut caller, |memory, host| {
                let data = &memory[range(memory, buf, len)?];
                let n = host.net.write(handle, data);
                trace(host, format_args!("write({handle}, {len}) -> {n}"));
                Ok(n)
            })
        }),
        Func::wrap(&mut *store, |mut caller: Caller<'_, Host>, handle: i32| -> i32 {
            let host = caller.data_mut();
            let result = host.net.close(handle);
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
                let output = host.net.error(handle);
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
    ]
}
