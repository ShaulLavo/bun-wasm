import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function patchSection(path: string): string {
  const patch = readFileSync(join(root, 'jsc/webkit-wasi.patch'), 'utf8');
  const section = patch.split('diff --git ').find((entry) => entry.startsWith(`a/${path} `));
  assert.ok(section);
  return `diff --git ${section}`;
}

function withTelemetryHeader(run: (scratch: string) => void): void {
  const scratch = mkdtempSync(join(process.env.TMPDIR || process.env.RUNNER_TEMP || tmpdir(), 'bun-wasm-jsc-telemetry-test-'));
  try {
    const headerPatch = patchSection('Source/JavaScriptCore/runtime/WASIMemoryTelemetry.h');
    const header = headerPatch.split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1)).join('\n');
    writeFileSync(join(scratch, 'WASIMemoryTelemetry.h'), header);
    run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('WASI JSC telemetry retains the original request without entering the VM', () => {
  withTelemetryHeader((scratch) => {
    const otherSource = join(scratch, 'other.cpp');
    writeFileSync(otherSource, `#include "WASIMemoryTelemetry.h"
const BunjscMemoryTelemetry* otherTranslationUnit() { return bunjsc_cached_memory_telemetry(); }
`);
    const binary = join(scratch, 'telemetry-test');
    execFileSync('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', scratch,
      join(root, 'crates/bunwasm-jsc/tests/memory-telemetry.cpp'), otherSource, '-o', binary]);
    for (const scenario of ['success', 'failure', 'nested', 'abandoned', 'wide', 'repeated', 'observed-construction', 'explicit-failure', 'unknown-failure']) {
      assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8' }).trim(), scenario);
    }
  });
});

test('patched typed-array nullable failure latches before an OOM callback that does not unwind', () => {
  withTelemetryHeader((scratch) => {
    const path = 'Source/JavaScriptCore/runtime/JSGenericTypedArrayViewInlines.h';
    mkdirSync(join(scratch, 'Source/JavaScriptCore/runtime'), { recursive: true });
    copyFileSync(join(root, 'crates/bunwasm-jsc/tests/typed-array-create.h'), join(scratch, path));
    execFileSync('git', ['apply', '-'], { cwd: scratch, input: patchSection(path) });
    const source = readFileSync(join(scratch, path), 'utf8');
    const start = source.indexOf('template<typename Adaptor>\nJSGenericTypedArrayView<Adaptor>* JSGenericTypedArrayView<Adaptor>::create(');
    assert.notEqual(start, -1);
    writeFileSync(join(scratch, 'TypedArrayCreate.h'), `${source.slice(start)}\n} // namespace JSC\n`);
    for (const wasi of ['1', '0']) {
      checkTypedArrayCallbacks(scratch, wasi);
    }
  });
});

function checkTypedArrayCallbacks(scratch: string, wasi: string): void {
  const binary = join(scratch, `typed-array-test-${wasi}`);
  execFileSync('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', `-DBUNJSC_TEST_WASI=${wasi}`, '-I', scratch,
    join(root, 'crates/bunwasm-jsc/tests/typed-array-create.cpp'), '-o', binary]);
  for (const scenario of ['success', 'nullable-return', 'nullable-trap', 'cell-trap']) {
    assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8' }).trim(), scenario);
  }
}
