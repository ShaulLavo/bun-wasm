import { expect, test } from "bun:test";
import { importDelta } from "./hermes-import-delta.ts";

const name = (text: string) => [text.length].concat(Array.from(new TextEncoder().encode(text)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
const global = (module: string, field: string, mutable: number) => name(module).concat(name(field), [3, 0x7f, mutable]);

// A side importing two env functions and four globals, defining and exporting `own`.
function side(): WebAssembly.Module {
  const imports = [
    name("env").concat(name("malloc"), [0, 0]),
    name("env").concat(name("extra"), [0, 0]),
    global("env", "__memory_base", 0),
    global("GOT.mem", "errno", 1),
    global("GOT.mem", "sideData", 1),
    global("GOT.func", "own", 1),
  ];
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]),
    section(2, [imports.length].concat(...imports)),
    section(3, [1, 0]),
    section(7, [1].concat(name("own"), [0, 2])),
    section(10, [1, 2, 0, 0x0b]),
  );
  return new WebAssembly.Module(Uint8Array.from(bytes));
}

test("lists env and GOT imports neither the core nor the side provides", () => {
  expect(importDelta(side(), new Set(["malloc", "errno"]))).toEqual(["GOT.mem.sideData", "env.extra"]);
});

test("a core export satisfies every namespace", () => {
  expect(importDelta(side(), new Set(["malloc", "errno", "extra", "sideData"]))).toEqual([]);
});
