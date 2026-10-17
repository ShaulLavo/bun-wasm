import { expect, test } from "bun:test";
import { DescriptorTable } from "waffle/core/descriptors";
import { MemFS } from "waffle/fs/memory";
import { ProcessABI } from "waffle/proc/abi";
import { outcomeWord } from "waffle/proc/outcome";
import { createSignalState } from "waffle/proc/signals";
import type { SpawnRequest } from "waffle/proc/types";

// The same fixture drives the native host's decoder (tests/fixtures/runtime-proc-spawn-requests.json).
// "valid" means the generic ProcessABI decoder accepts the JSON; the service may still refuse it.
interface Entry { name: string; valid: boolean; request: unknown }
const fixture: Entry[] = await Bun.file(new URL("../../tests/fixtures/runtime-proc-spawn-requests.json", import.meta.url)).json();

function decoder() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const decoded: SpawnRequest[] = [];
  const unused = (): never => { throw new Error("unexpected service operation"); };
  const abi = new ProcessABI({ memory, descriptors: new DescriptorTable(), fs: new MemFS(), pid: 1,
    signals: { signalState: createSignalState(), interrupt: new Int32Array(new SharedArrayBuffer(4)),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)), outcome: outcomeWord() },
    service: { spawn(_parent, request) { decoded.push(request); return 77; }, wait: unused, waitJob: unused, jobEmpty: unused,
      kill: unused, killJob: unused, jobOf: unused, defaultSignal: unused } });
  return { decoded, spawn(json: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    new Uint8Array(memory.buffer, 1024, bytes.length).set(bytes);
    return abi.imports.spawn!(1024, bytes.length);
  } };
}

test("the fixture covers both outcomes and every named case once", () => {
  expect(new Set(fixture.map(entry => entry.name)).size).toBe(fixture.length);
  expect(fixture.some(entry => entry.valid)).toBe(true);
  expect(fixture.some(entry => !entry.valid)).toBe(true);
});

for (const entry of fixture) test(`spawn JSON ${entry.valid ? "accepts" : "rejects"}: ${entry.name}`, () => {
  const host = decoder();
  const result = host.spawn(entry.request);
  if (!entry.valid) {
    // EINVAL, and the service never sees a description it could not decode.
    expect(result).toBe(-28);
    expect(host.decoded).toEqual([]);
    return;
  }
  expect(result).toBe(77);
  expect(host.decoded).toHaveLength(1);
  const request = entry.request as SpawnRequest;
  const got = host.decoded[0]!;
  expect({ executable: got.executable, argv: got.argv, env: got.env, cwd: got.cwd, job: got.job, fds: got.fds })
    .toEqual({ executable: request.executable, argv: request.argv, env: request.env, cwd: request.cwd, job: request.job, fds: request.fds });
});
