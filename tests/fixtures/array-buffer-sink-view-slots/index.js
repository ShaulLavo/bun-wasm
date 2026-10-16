const factories = [
  ["DataView", (buffer) => new DataView(buffer, 1, 2), "2,3"],
  ["Uint8Array", (buffer) => new Uint8Array(buffer, 1, 2), "2,3"],
  ["Uint16Array", (buffer) => new Uint16Array(buffer, 2, 1), "3,4"],
];
let failed = false;
for (const [name, create, expected] of factories) {
  for (const throwing of [false, true]) {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    const view = create(bytes.buffer);
    const fake = Uint8Array.of(8, 9, 10, 11);
    for (const [key, value] of [["buffer", fake.buffer], ["byteOffset", 0], ["byteLength", 4]]) {
      const descriptor = throwing ? { get() { throw new Error("shadow getter " + key); } } : { value };
      Object.defineProperty(view, key, descriptor);
    }
    let ok = false;
    try {
      const sink = new Bun.ArrayBufferSink();
      const written = sink.write(view);
      bytes.fill(0);
      ok = written === 2 && Array.from(new Uint8Array(sink.end())).join() === expected;
    } catch (error) { console.error(name, error.message); }
    console.log(name, throwing ? "throwing getters" : "shadowed bounds", ok);
    if (!ok) failed = true;
  }
}
if (failed) throw new Error("ArrayBufferView internal slots regression");
