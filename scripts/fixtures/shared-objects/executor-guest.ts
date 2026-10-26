const name = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const unsigned = (value: number): number[] => {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
};
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
export const PROCESS_IMPORTS = [
  "access_cancel", "access_start", "access_take", "default_signal", "dup", "getpid",
  "interrupted", "job_of", "kill", "kill_job", "pipe", "poll", "read", "signal", "spawn",
  "wait", "wait_job", "write",
] as const;
/** Exports memory, an empty `_start` and `bunwasm_ready` returning `ready`.
 * Imports are linked but invoked directly by the test, so their dummy Wasm type is unused. */
export function guest(ready: number, imports: readonly { namespace: string; name: string }[] = []): WebAssembly.Module {
  return new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]),
    imports.length ? section(2, [imports.length].concat(imports.flatMap(entry => name(entry.namespace).concat(name(entry.name), [0, 0])))) : [],
    section(3, [2, 0, 1]), section(5, [1, 0, 1]),
    section(7, [3].concat(name("memory"), [2, 0], name("_start"), [0, imports.length], name("bunwasm_ready"), [0, imports.length + 1])),
    section(10, [2, 2, 0, 0x0b, 4, 0, 0x41, ready, 0x0b]),
  )));
}

