// Original byte-encoded preview1 fixtures: no compiler, downloaded guest or dist artifact in CI.
// Default cancellation explicitly calls default_signal and traps if that import ever returns.
// Merely calling a host import does not reliably stop CPU-bound WebKit/Safari WASM.
export type ProcessFixture = "exit" | "default" | "handled" | "handling" | "handled-trap" | "unrunnable";
function uint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function text(value: string): number[] { const bytes = Array.from(new TextEncoder().encode(value)); return uint(bytes.length).concat(bytes); }
function section(id: number, payload: number[]): number[] { return [id].concat(uint(payload.length), payload); }
function constant(value: number): number[] {
  // Signed LEB128 (all fixture addresses are positive).
  const bytes: number[] = [];
  do { const byte = value & 127; value >>= 7; const more = value !== 0 || (byte & 64) !== 0; bytes.push(byte | (more ? 128 : 0)); if (!more) break; } while (true);
  return [0x41].concat(bytes);
}
function output(iovec: number): number[] { return constant(1).concat(constant(iovec), constant(1), constant(24), [0x10, 0, 0x1a]); }
export function processFixture(mode: ProcessFixture): Uint8Array<ArrayBuffer> {
  const types = [4, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0];
  const imports = [3].concat(
    text("wasi_snapshot_preview1"), text("fd_write"), [0, 0],
    text(mode === "unrunnable" ? "unavailable_process_adapter" : "runtime_proc"), text("interrupted"), [0, 1],
    text("runtime_proc"), text("default_signal"), [0, 2],
  );
  let body = [1, 1, 0x7f].concat(output(0)); // one i32 local, ready\n before CPU work
  if (mode !== "exit" && mode !== "unrunnable") {
    body = body.concat([0x03, 0x40, 0x10, 1, 0x22, 0, 0x04, 0x40]); // loop; interrupted(); tee signal; if
    if (mode === "default") body = body.concat([0x20, 0, 0x10, 2, 0x00]); // default_signal(signal); unreachable
    else if (mode === "handled") body.push(0x0f); // guest handles the signal and returns status zero
    else if (mode === "handled-trap") body.push(0x00); // unrelated trap must not be mistaken for default signal
    else body = body.concat([0x20, 0, 0x41, 9, 0x46, 0x04, 0x40, 0x20, 0, 0x10, 2, 0x00, 0x0b], output(32)); // INT handler stays active; KILL takes the default trap
    body = body.concat([0x0b, 0x0c, 0, 0x0b]); // endif; branch loop; endloop
  }
  body.push(0x0b);
  const memory = new Uint8Array(49);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 8, true); view.setUint32(4, 6, true);
  memory.set(new TextEncoder().encode("ready\n"), 8);
  view.setUint32(32, 40, true); view.setUint32(36, 9, true);
  memory.set(new TextEncoder().encode("handling\n"), 40);
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, types), section(2, imports), section(3, [1, 3]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 3])),
    section(10, [1].concat(uint(body.length), body)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(uint(memory.length), Array.from(memory))),
  ));
}
