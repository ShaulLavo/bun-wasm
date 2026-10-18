// Original byte-encoded guest. CI checks the CLI imports and the real page runner without Rust.
function uint(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return uint(bytes.length).concat(bytes);
}
function section(id: number, bytes: number[]): number[] { return [id].concat(uint(bytes.length), bytes); }
const constant = (value: number) => [0x41].concat(uint(value));
const call = (index: number, ...args: number[][]) => args.flat().concat([0x10], uint(index));
const check = (instructions: number[], expected: number) => instructions.concat(constant(expected), [0x47, 0x04, 0x40, 0x00, 0x0b]);

export function cliShimFixture(mode: "exit" | "signal" | "wait" = "exit"): Uint8Array<ArrayBuffer> {
  const imports: [string, number][] = [
    ["signal", 2], ["spawn", 2], ["write", 3], ["access_start", 5], ["access_take", 1], ["access_cancel", 1],
    ["job_of", 1], ["kill_job", 2], ["wait_job", 3], ["start_status", 1], ["kill", 2], ["pipe", 1],
    ["poll", 4], ["read", 3], ["wait", 2],
  ];
  const signatures = Array.from({ length: 6 }, (_, arity) => [0x60].concat(uint(arity), Array.from({ length: arity }, () => 0x7f), [1, 0x7f]));
  const marker = new TextEncoder().encode(mode === "wait" ? "runner-ready\n" : "cli-shim-ok\n");
  const body = mode === "signal" ? call(0, constant(2), constant(3)).concat([0x1a]) :
    check(call(0, constant(10), constant(1)), 0).concat(
      check(call(0, constant(10), constant(3)), 0), check(call(0, constant(0), constant(0)), 10),
      check(call(0, constant(0), constant(0)), 0), check(call(0, constant(10), constant(0)), 0),
      check(call(2, constant(1), constant(0), constant(marker.length)), marker.length),
      mode === "wait" ? [0x03, 0x40].concat(call(0, constant(0), constant(0)), [0x1a],
        call(12, constant(0), constant(0), constant(10), constant(64)), [0x1a, 0x0c, 0, 0x0b]) : []);
  const code = [0].concat(body, [0x0b]);
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, uint(7).concat(signatures.flat(), [0x60, 0, 0])),
    section(2, uint(imports.length).concat(imports.flatMap(([name, arity]) => text("runtime_proc").concat(text(name), [0], uint(arity))))),
    section(3, [1, 6]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0], uint(imports.length))),
    section(10, [1].concat(uint(code.length), code)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(uint(marker.length), Array.from(marker))),
  ));
}
