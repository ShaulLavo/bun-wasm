import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('WASI JSC telemetry retains the original request without entering the VM', () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR || process.env.RUNNER_TEMP || tmpdir(), 'bun-wasm-jsc-telemetry-test-'));
  try {
    const patch = readFileSync(join(root, 'jsc/webkit-wasi.patch'), 'utf8');
    const headerPatch = patch.split('diff --git ').find((entry) =>
      entry.startsWith('a/Source/JavaScriptCore/runtime/WASIMemoryTelemetry.h '));
    assert.ok(headerPatch);
    const header = headerPatch.split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1)).join('\n');
    writeFileSync(join(scratch, 'WASIMemoryTelemetry.h'), header);
    const otherSource = join(scratch, 'other.cpp');
    writeFileSync(otherSource, `#include "WASIMemoryTelemetry.h"
const BunjscMemoryTelemetry* otherTranslationUnit() { return bunjsc_cached_memory_telemetry(); }
`);
    const binary = join(scratch, 'telemetry-test');
    execFileSync('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', scratch,
      join(root, 'crates/bunwasm-jsc/tests/memory-telemetry.cpp'), otherSource, '-o', binary]);
    for (const scenario of ['success', 'failure', 'nested', 'abandoned', 'wide', 'repeated']) {
      assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8' }).trim(), scenario);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
