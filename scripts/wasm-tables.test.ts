import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(args, { cwd: root, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}
test('real production native table/reference bridge', () => {
  const scratch = mkdtempSync(join(process.env.WASM_TABLE_TMP ?? '/work/tmp', 'wasm-tables-'));
  try {
    mkdirSync(join(scratch, 'src'));
    const natives = readFileSync(join(root, 'crates/bunwasm-runtime/src/natives.rs'), 'utf8');
    const start = natives.indexOf('#[derive(Default)]\npub struct Table');
    const end = natives.indexOf("/// Node's (code", start);
    const registry = natives.slice(start, end);
    writeFileSync(join(scratch, 'Cargo.toml'), `[package]\nname="wasm-table-source-unit"\nversion="0.0.0"\nedition="2024"\n[workspace]\n[dependencies]\nwasmi={path="${root}/third_party/wasmi",default-features=false,features=["std"]}\nserde_json="1"\nbase64="0.22"\n`);
    writeFileSync(join(scratch, 'src/main.rs'), `#![allow(dead_code,unexpected_cfgs)]\n#[path="${root}/crates/bunwasm-runtime/src/data.rs"] mod data;\nmod engine { pub use crate::data::{NativeError,NativeResult,Record,Val}; }\nmod natives { use std::rc::Rc; use crate::data::{Args,DataFn,NativeResult,Val};\n${registry}\n}\n#[path="${root}/crates/bunwasm-runtime/src/wasm.rs"] mod wasm;\n` + readFileSync(join(root, 'tests/wasm-tables/native.rs'), 'utf8'));
    run(['cargo', 'build', '--offline', '--manifest-path', join(scratch, 'Cargo.toml'), '-j', '2'], { CARGO_TARGET_DIR: join(scratch, 'target') });
    for (const name of ['table', 'import-table', 'externref']) run(['wasm-tools', 'parse', join(root, 'tests/wasm-tables/' + name + '.wat'), '-o', join(scratch, name + '.wasm')]);
    run(['mkfifo', join(scratch, 'input'), join(scratch, 'output')]);
    console.log(run(['node', '--expose-gc', '--disable-warning=ExperimentalWarning', join(root, 'tests/wasm-tables/client.ts')], { WASM_TABLE_SCRATCH: scratch }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
