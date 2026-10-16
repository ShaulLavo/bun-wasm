const cases = [
  ["lone high", "\ud800", [239, 191, 189]],
  ["lone low", "\udc00", [239, 191, 189]],
  ["mixed text", "a\ud800b\udc00c", [97, 239, 191, 189, 98, 239, 191, 189, 99]],
  ["valid pair", "\ud83d\ude0b", [240, 159, 152, 139]],
];
let failed = false;
for (const [name, text, expected] of cases) {
  let ok = false;
  try {
    const sink = new Bun.ArrayBufferSink();
    const count = sink.write(text);
    ok = count === expected.length && Array.from(new Uint8Array(sink.end())).join() === expected.join();
    ok = ok && Array.from(new TextEncoder().encode(text)).join() === expected.join();
  } catch (error) { console.error(name, error.message); }
  console.log(name, ok);
  if (!ok) failed = true;
}
if (failed) throw new Error("UTF-16 string boundary regression");
