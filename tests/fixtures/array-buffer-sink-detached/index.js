const factories = [
  ["ArrayBuffer", (buffer) => buffer],
  ["Uint8Array", (buffer) => new Uint8Array(buffer, 1, 2)],
  ["DataView", (buffer) => new DataView(buffer, 1, 2)],
];
let failed = false;
function check(name, create, pending) {
  const buffer = new ArrayBuffer(4);
  const input = create(buffer);
  buffer.transfer();
  Object.defineProperty(buffer, "byteLength", { get() { throw new Error("shadowed buffer length"); } });
  const sink = new Bun.ArrayBufferSink();
  if (pending) sink.write("a");
  let ok = false;
  try {
    const written = sink.write(input);
    const bytes = Array.from(new Uint8Array(sink.end())).join();
    ok = written === 0 && bytes === (pending ? "97" : "");
  } catch (error) { console.error(name, error.message); }
  console.log(name, "detached", pending ? "pending" : "empty", ok);
  if (!ok) failed = true;
}
for (const [name, create] of factories) {
  for (const pending of [false, true]) check(name, create, pending);
}
if (failed) throw new Error("detached sink input regression");
