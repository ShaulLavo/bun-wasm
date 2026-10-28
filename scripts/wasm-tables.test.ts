import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}
function stopOwnedNative(pid: number, scratch: string) {
  const command = `/proc/${pid}/cmdline`;
  if (!existsSync(command)) return;
  if (!readFileSync(command, 'utf8').startsWith(join(scratch, 'target/debug/wasm-table-source-unit'))) return;
  process.kill(pid, 'SIGKILL');
}
test('real production native table/reference bridge', () => {
  const scratch = mkdtempSync(join(process.env.WASM_TABLE_TMP ?? process.env.RUNNER_TEMP ?? (existsSync('/work/tmp') ? '/work/tmp' : tmpdir()), 'wasm-tables-'));
  try {
    mkdirSync(join(scratch, 'src'));
    const natives = readFileSync(join(root, 'crates/bunwasm-runtime/src/natives.rs'), 'utf8');
    const start = natives.indexOf('#[derive(Default)]\npub struct Table');
    const end = natives.indexOf("/// Node's (code", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const registry = natives.slice(start, end);
    writeFileSync(join(scratch, 'Cargo.toml'), `[package]\nname="wasm-table-source-unit"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[dependencies]\nwasmi={path="${root}/third_party/wasmi",default-features=false,features=["std"]}\nserde_json="1"\nbase64="0.22"\n[patch.crates-io]\nwasmi_core={path="${root}/third_party/wasmi_core"}\n`);
    writeFileSync(join(scratch, 'src/main.rs'), `#![allow(dead_code,unexpected_cfgs)]\n#[path="${root}/crates/bunwasm-runtime/src/data.rs"] mod data;\nmod engine { pub use crate::data::{NativeError,NativeResult,Record,Val}; }\nmod natives { use std::rc::Rc; use crate::data::{Args,DataFn,NativeResult,Val};\n${registry}\n}\n#[path="${root}/crates/bunwasm-runtime/src/wasm.rs"] mod wasm;\n` + readFileSync(join(root, 'tests/wasm-tables/native.rs'), 'utf8'));
    run(['cargo', 'build', '--offline', '--manifest-path', join(scratch, 'Cargo.toml'), '-j', '2'], { CARGO_TARGET_DIR: join(scratch, 'target') });
    for (const name of ['table', 'import-table', 'externref', 'memory-owner', 'signatures', 'reuse', 'numeric', 'memory-lifetime', 'memory-reexport']) run(['wasm-tools', 'parse', join(root, 'tests/wasm-tables/' + name + '.wat'), '-o', join(scratch, name + '.wasm')]);
    console.log(run(['env', '-u', 'WASM_TABLE_SCRATCH', '-u', 'TABLE_FIXTURES', 'cargo', 'test', '--offline', '--manifest-path', join(scratch, 'Cargo.toml'), '-j', '2'], { CARGO_TARGET_DIR: join(scratch, 'target') }));
    console.log(run(['cargo', 'clippy', '--offline', '--manifest-path', join(scratch, 'Cargo.toml'), '-j', '2', '--all-targets', '--no-deps', '--', '-Dwarnings'], { CARGO_TARGET_DIR: join(scratch, 'target') }));
    run(['mkfifo', join(scratch, 'input'), join(scratch, 'output')]);
    console.log(run(['node', '--expose-gc', '--disable-warning=ExperimentalWarning', join(root, 'tests/wasm-tables/client.ts')], { WASM_TABLE_SCRATCH: scratch }));
  } finally {
    const pidFile = join(scratch, 'native.pid');
    if (existsSync(pidFile)) stopOwnedNative(Number(readFileSync(pidFile, 'utf8')), scratch);
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
