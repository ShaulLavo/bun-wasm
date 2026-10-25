import { strict as assert } from "node:assert";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";

const path = "bun-file-data.txt";
writeFileSync(path, "abcdef");
let fd = openSync(path, "r+");
try {
  readSync(fd, new Uint8Array(2));
  const file = Bun.file(fd);
  assert.equal(file.size, 6);
  assert.equal((await file.stat()).isFile(), true);
  assert.equal(await file.exists(), true);
  assert.equal(await file.text(), "cdef");
  assert.equal(await file.text(), "");
  assert.equal(fstatSync(fd).size, 6);
} finally { closeSync(fd); }
console.log("descriptor reads and stat");

for (const [start, end, streaming, expected, next] of [
  [1, 3, false, "bc", "de"],
  [1, 3, true, "bc", "cd"],
  [0, 3, false, "cde", "f"],
] satisfies [number, number, boolean, string, string][]) {
  fd = openSync(path, "r");
  try {
    readSync(fd, new Uint8Array(2));
    const file = Bun.file(fd).slice(start, end);
    const output = streaming ? await Bun.readableStreamToText(file.stream()) : await file.text();
    assert.equal(output, expected);
    const bytes = new Uint8Array(2);
    const count = readSync(fd, bytes);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, count)), next);
  } finally { closeSync(fd); }
}
console.log("sliced descriptor reads match native cursor positions");

fd = openSync(path, "r+");
try {
  assert.equal(await Bun.write(fd, "new"), 3);
  assert.equal(await Bun.write(Bun.file(fd), "!"), 1);
  assert.equal(readFileSync(path, "utf8"), "new!ef");
  assert.equal(existsSync(String(fd)), false);
  assert.equal(fstatSync(fd).size, 6);
} finally { closeSync(fd); }
await assert.rejects(() => Bun.file(fd).text(), { code: "EBADF" });
await assert.rejects(() => Bun.file(fd).stat(), { code: "EBADF" });
await assert.rejects(() => Bun.write(fd, "x"), { code: "EBADF" });
for (const invalid of [-1, 1.5, NaN, Infinity, 2147483648]) {
  assert.throws(() => Bun.file(invalid), { code: "ERR_OUT_OF_RANGE" });
  assert.throws(() => Bun.write(invalid, ""), { code: "ERR_OUT_OF_RANGE" });
}
console.log("descriptor writes and errors");

writeFileSync(path, "abcdef");
for (const [start, end, expected] of [[1, 3, "bc"], [1.5, 3, "bc"], [NaN, 3, "abc"], [1, 3.5, "bc"], [1, NaN, ""]] satisfies [number, number | undefined, string][]) {
  assert.equal(await Bun.file(path).slice(start, end).text(), expected);
  assert.equal(await Bun.readableStreamToText(Bun.file(path).slice(start, end).stream()), expected);
}
console.log("slice indexes normalize before reads");

const text = "0123456789".repeat(30_000);
writeFileSync(path, text);
fd = openSync(path, "r");
try {
  readSync(fd, new Uint8Array(3));
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal(await Bun.readableStreamToText(Bun.file(fd).slice(17, 140_003).stream()), text.slice(17, 140_003));
  }
  const first = Bun.file(fd).stream().getReader();
  const chunk = await first.read();
  assert.equal(chunk.done, false);
  assert.ok(chunk.value && chunk.value.length <= 262_144 && chunk.value.length > 0);
  await first.cancel();
  const byte = new Uint8Array(1);
  readSync(fd, byte);
  assert.equal(new TextDecoder().decode(byte), "3");
  assert.equal(fstatSync(fd).size, text.length);
} finally { closeSync(fd); }
console.log("bounded streams preserve descriptor position");

assert.equal(await Bun.file(path).slice(123, 4219).text(), text.slice(123, 4219));
assert.equal(await Bun.file(path).slice(text.length - 2, text.length + 20).text(), text.slice(-2));
assert.equal(await Bun.file(path).slice(5, 5).text(), "");
assert.equal(await Bun.file(path).slice(text.length + 1).text(), "");
const owned = Bun.file(path).stream().getReader();
await owned.read();
await owned.cancel();
await Bun.file(path).stream().cancel();
await assert.rejects(async () => Bun.file("absent-bun-file").stream().getReader().read(), { code: "ENOENT" });
unlinkSync(path);
console.log("path ranges, cancellation and missing-file errors");
assert.equal(await Bun.write(1, "numeric stdout\n"), 15);
assert.equal(await Bun.stdin.text(), "file stdin\n");
assert.ok(fstatSync(0));
console.log("stdin remains caller owned");
