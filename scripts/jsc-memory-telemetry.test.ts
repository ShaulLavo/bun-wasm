import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { allocationBoundaryBytes, boundaryGenerationFindings, boundaryRejections, boundaryStates, decodeAllocationBoundary } from '../web/src/jsc-allocation-boundary.ts';

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

const boundaryScenarios = ['layout', 'disarmed', 'control-success', 'control-core-failure', 'control-null',
  'control-not-observed', 'control-request', 'control-attempts', 'sampler-unbound', 'sampler-unreadable',
  'coverage-miss', 'subject-latch', 'rearm-refused', 'no-collection', 'trap-pending', 'generation-zero',
  'generation-above-limit', 'generation-unknown', 'control-generation'];

test('WASI JSC allocation boundary arms the subject only after an acknowledged control', () => {
  withTelemetryHeader((scratch) => {
    const binary = join(scratch, 'allocation-boundary-test');
    execFileSync('c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', scratch,
      join(root, 'crates/bunwasm-jsc/tests/allocation-boundary.cpp'), '-o', binary]);
    for (const scenario of boundaryScenarios) {
      assert.equal(execFileSync(binary, [scenario], { encoding: 'utf8' }).trim(), scenario);
    }
    const words = execFileSync(binary, ['dump'], { encoding: 'utf8' }).trim().split('\n').map(BigInt);
    assert.equal(words.length * 8, allocationBoundaryBytes);
    const record = decodeAllocationBoundary(words, 0x1f2e3d4c5b6a7);
    assert.equal(boundaryStates[record.state ?? -1], 'subjectArmed');
    assert.equal(boundaryRejections[record.rejection ?? -1], 'none');
    assert.equal(record.controlLength, 1001);
    assert.equal(record.generation, 0x1f2e3d4c5b6a7);
    assert.deepEqual(boundaryGenerationFindings([record]), [[]]);
    assert.equal(record.control.generation, record.generation);
    assert.equal(record.subject.generation, record.generation);
    assert.equal(record.subjectFailures, 2);
    assert.equal(record.coverageMisses, 1);
    assert.equal(record.control.requestBytes, 1001);
    assert.equal(record.control['coreAfter.allocations'], (record.control['coreBefore.allocations'] ?? 0) + 1);
    assert.equal(record.subject.requestBytes, 25297737);
    assert.equal(record.subject.errnoAfterCall, constants.errno.ENOMEM, 'the raw value the fake allocator left');
    assert.equal(record.subject['heap.ramSize'], 1073741824);
    assert.equal(record.subject['coreAfter.failures'], (record.subject['coreBefore.failures'] ?? 0) + 1);
    assert.equal(record.subject['coreBefore.firstFailureSize'], null, 'the core reports no failure as UINT64_MAX');
    assert.equal(record.subject['coreBefore.firstFailureCategory'], 0);
    assert.equal(record.last.requestBytes, 40000000);
  });
});

test('the boundary probe wraps exactly the two oversize Gigacage calls', () => {
  const section = patchSection('Source/JavaScriptCore/runtime/JSArrayBufferView.cpp').split('\n');
  const probe = section.indexOf('+    WASIAllocationBoundaryProbe boundary(&vm, structure, vm.heap, length, elementSize, size.value(), mode == ZeroFill);');
  assert.notEqual(probe, -1);
  assert.deepEqual(section.slice(probe - 2, probe + 9), [
    '     void* memory = nullptr;',
    '+#if OS(WASI)',
    '+    WASIAllocationBoundaryProbe boundary(&vm, structure, vm.heap, length, elementSize, size.value(), mode == ZeroFill);',
    '+#endif',
    '     if (mode == ZeroFill)',
    '         memory = Gigacage::tryZeroedMalloc(Gigacage::Primitive, size.value());',
    '     else',
    '         memory = Gigacage::tryMalloc(Gigacage::Primitive, size.value());',
    '+#if OS(WASI)',
    '+    boundary.finish(memory);',
    '+#endif',
  ]);
  assert.equal(section.filter(line => line.includes('WASIAllocationBoundaryProbe')).length, 1);
  const heap = patchSection('Source/JavaScriptCore/heap/Heap.h');
  for (const accessor of ['size_t maxHeapSize() const { return m_maxHeapSize; }', 'size_t ramSize() const { return m_ramSize; }',
    'size_t bytesAllocatedThisCycle() const { return m_nonOversizedBytesAllocatedThisCycle + m_oversizedBytesAllocatedThisCycle; }']) {
    assert.ok(heap.includes(`+    ${accessor}\n`), accessor);
  }
});
