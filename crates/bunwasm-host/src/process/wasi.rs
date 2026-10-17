//! Preview1 and runtime_proc use the same effective descriptor namespace. The
//! process-owned streams are intercepted here; filesystem descriptors remain
//! owned by Wasmtime and are deliberately not transferable through spawn.
use anyhow::{Context, Result};
use wasmtime::{Caller, Func, Linker, Store, Val};

use super::{AGAIN, BADF, FAULT, INVAL};
use crate::Host;

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
    signature.extend(std::iter::repeat_n(0x7f, count as usize));
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
    let function = {
        let mut cached = delegate.cached.lock().unwrap();
        if let Some(function) = *cached {
            function
        } else {
            let mut linker = Linker::new(caller.engine());
            linker.define(&mut *caller, "t", "f", delegate.original)?;
            let memory = caller.data().memory.context("bun.wasm exports no memory")?;
            linker.define(&mut *caller, "t", "m", memory)?;
            let instance = linker.instantiate(&mut *caller, &delegate.module)?;
            let function = instance
                .get_func(&mut *caller, "run")
                .context("missing adapter")?;
            *cached = Some(function);
            function
        }
    };
    let args: Vec<Val> = args.iter().map(|&arg| Val::I32(arg)).collect();
    let mut result = [Val::I32(0)];
    function.call(caller, &args, &mut result)?;
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
    let memory = caller.data().memory.context("bun.wasm exports no memory")?;
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

pub fn install(linker: &mut Linker<Host>, store: &mut Store<Host>) -> Result<()> {
    let close = std::sync::Arc::new(original(linker, store, "fd_close")?);
    let close_renumber = close.clone();
    let read = original(linker, store, "fd_read")?;
    let write = original(linker, store, "fd_write")?;
    let renumber = original(linker, store, "fd_renumber")?;
    let fdstat = original(linker, store, "fd_fdstat_get")?;
    let filestat = original(linker, store, "fd_filestat_get")?;
    linker.allow_shadowing(true);
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_close",
        move |mut caller: Caller<'_, Host>, fd: i32| -> Result<i32> {
            if caller.data().processes.owns(fd) {
                let result = caller.data_mut().processes.close(fd);
                if (0..=2).contains(&fd) {
                    let _ = call(&close, &mut caller, &[fd])?;
                }
                return Ok(-result);
            }
            call(&close, &mut caller, &[fd])
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_read",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              ptr: i32,
              count: i32,
              out: i32|
              -> Result<i32> {
            if caller.data().processes.owns(fd) {
                io(&mut caller, false, fd, ptr, count, out)
            } else {
                call(&read, &mut caller, &[fd, ptr, count, out])
            }
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_write",
        move |mut caller: Caller<'_, Host>,
              fd: i32,
              ptr: i32,
              count: i32,
              out: i32|
              -> Result<i32> {
            if caller.data().processes.owns(fd) {
                io(&mut caller, true, fd, ptr, count, out)
            } else {
                call(&write, &mut caller, &[fd, ptr, count, out])
            }
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_renumber",
        move |mut caller: Caller<'_, Host>, from: i32, to: i32| -> Result<i32> {
            if caller.data().processes.owns(from) {
                if to < 0 {
                    return Ok(-INVAL);
                }
                if !caller.data().processes.owns(to) {
                    let _ = call(&close_renumber, &mut caller, &[to])?;
                }
                let result = caller.data_mut().processes.renumber(from, to);
                if result == 0 && from != to && (0..=2).contains(&from) {
                    // Remove the original weak stdio entry too: it must not keep
                    // serving the old number after the open description moves.
                    let _ = call(&close_renumber, &mut caller, &[from])?;
                }
                return Ok(-result);
            }
            // A private Wasmtime file cannot be moved into the process table.
            if caller.data().processes.owns(to) {
                return Ok(-BADF);
            }
            call(&renumber, &mut caller, &[from, to])
        },
    )?;
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_fdstat_get",
        move |mut caller: Caller<'_, Host>, fd: i32, out: i32| -> Result<i32> {
            let Some((terminal, rights)) = caller.data().processes.fdstat(fd) else {
                return call(&fdstat, &mut caller, &[fd, out]);
            };
            let memory = caller.data().memory.context("bun.wasm exports no memory")?;
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
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_filestat_get",
        move |mut caller: Caller<'_, Host>, fd: i32, out: i32| -> Result<i32> {
            let Some((terminal, _)) = caller.data().processes.fdstat(fd) else {
                return call(&filestat, &mut caller, &[fd, out]);
            };
            let memory = caller.data().memory.context("bun.wasm exports no memory")?;
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
