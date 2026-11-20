import fs, { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

// fs calls take their arguments as Bun's src/js/node/fs.ts does: the optional forms of
// read and write, validation order and messages, promisify results, and the module shape.
const describe = (error: unknown) => {
  const { name, code, message } = error as { name: string; code?: string; message: string };
  return `${name} ${code} ${message}`;
};
const attempt = (label: string, run: () => unknown) => {
  try {
    console.log(label, "ok", run());
  } catch (error) {
    console.log(label, describe(error));
  }
};
const settle = async (label: string, run: () => Promise<unknown>) => {
  try {
    console.log(label, "resolved", await run());
  } catch (error) {
    console.log(label, "rejected", describe(error));
  }
};
const callback = <T extends unknown[]>(start: (done: (...values: T) => void) => void) => new Promise<T>((resolve) => start((...values) => resolve(values)));

writeFileSync("read.txt", "bun bun bun bun");
const fd = openSync("read.txt", "r");

// read(fd, callback), read(fd, options, callback) and read(fd, buffer, options, callback).
{
  const [error, bytesRead, buffer] = await callback<[unknown, number, Buffer]>((done) => fs.read(fd, done as never));
  console.log("read(fd, cb)", error, bytesRead, buffer.length, buffer.subarray(0, bytesRead).toString());
}
{
  const target = Buffer.alloc(8);
  const [error, bytesRead, buffer] = await callback<[unknown, number, Buffer]>((done) => fs.read(fd, { buffer: target, offset: 1, length: 3, position: 4 }, done as never));
  console.log("read(fd, options, cb)", error, bytesRead, buffer === target, JSON.stringify(buffer.toString()));
}
{
  const target = Buffer.alloc(8);
  const [error, bytesRead, buffer] = await callback<[unknown, number, Buffer]>((done) => fs.read(fd, target, { offset: 2, length: 3, position: 0 }, done as never));
  console.log("read(fd, buffer, options, cb)", error, bytesRead, buffer === target, JSON.stringify(buffer.toString()));
}
{
  const target = Buffer.alloc(15);
  const result = await (promisify(fs.read) as (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>)(fd, target, 0, 15, 0);
  console.log("promisify(read)", Object.keys(result).join(), result.bytesRead, result.buffer === target);
  const vector = [Buffer.alloc(3), Buffer.alloc(4)];
  const readv = await (promisify(fs.readv) as (...args: unknown[]) => Promise<{ bytesRead: number; buffers: Buffer[] }>)(fd, vector, 0);
  console.log("promisify(readv)", Object.keys(readv).join(), readv.bytesRead, readv.buffers === vector);
}

// The buffer's type is checked before the offset.
for (const [buffer, offset] of [["not a buffer", -1], [123, "bad"], [null, -1], [{}, 1.5], [[1, 2, 3], -1]] as const) {
  attempt(`readSync(${JSON.stringify(buffer)}, ${JSON.stringify(offset)})`, () => fs.readSync(fd, buffer as never, offset as never, 5));
  attempt(`read(${JSON.stringify(buffer)}, ${JSON.stringify(offset)})`, () => fs.read(fd, buffer as never, offset as never, 5, 0, () => console.log("callback must not run")));
}
attempt("readSync(fd, 'x', { offset: -1 })", () => fs.readSync(fd, "x" as never, { offset: -1 }));
attempt("readSync offset -1", () => fs.readSync(fd, Buffer.alloc(4), -1, 4));
attempt("readSync offset 'bad'", () => fs.readSync(fd, Buffer.alloc(4), "bad" as never, 4));
closeSync(fd);

// write and writeSync check the offset against the buffer's byte length, with or without a length.
const out = openSync("write.txt", "w+");
const hello = Buffer.from("hello");
for (const view of [Buffer.from("hello"), new Uint8Array(3), new Uint16Array(2), new DataView(new ArrayBuffer(3)), new Uint8Array(0)]) {
  attempt(`writeSync(${view.constructor.name}, byteLength + 1)`, () => fs.writeSync(out, view, view.byteLength + 1));
}
for (const length of [undefined, null, "5"]) attempt(`writeSync(hello, 6, ${JSON.stringify(length)})`, () => fs.writeSync(out, hello, 6, length as never));
attempt("writeSync(hello, 6, undefined, 0)", () => fs.writeSync(out, hello, 6, undefined, 0));
attempt("writeSync(hello, { offset: 6 })", () => fs.writeSync(out, hello, { offset: 6 } as never));
attempt("write(hello, 6, cb)", () => fs.write(out, hello, 6, () => console.log("callback must not run")));
attempt("write(hello, 6, undefined, undefined, cb)", () => fs.write(out, hello, 6, undefined, undefined, () => console.log("callback must not run")));
attempt("write(hello, { offset: 6 }, cb)", () => fs.write(out, hello, { offset: 6 } as never, () => console.log("callback must not run")));
attempt("writeSync(hello, 5)", () => fs.writeSync(out, hello, 5));
attempt("writeSync(hello, 2)", () => fs.writeSync(out, hello, 2));
{
  const [error, written, buffer] = await callback<[unknown, number, Buffer]>((done) => fs.write(out, hello, 5, done as never));
  console.log("write(hello, 5, cb)", error, written, buffer === hello);
}
// A buffer that is neither a string nor a view is rejected before its encoding.
attempt("write({ length: 3 }, 0, 'hex', cb)", () => fs.write(out, { length: 3 } as never, 0, "hex" as never, () => console.log("callback must not run")));
attempt("writeSync({ length: 3 }, 0, 'hex')", () => fs.writeSync(out, { length: 3 } as never, 0, "hex" as never));
{
  const result = await (promisify(fs.write) as (...args: unknown[]) => Promise<{ bytesWritten: number; buffer: unknown }>)(out, "bun", 0);
  console.log("promisify(write)", Object.keys(result).join(), result.bytesWritten, result.buffer);
  const vector = [Buffer.from("ab")];
  const writev = await (promisify(fs.writev) as (...args: unknown[]) => Promise<{ bytesWritten: number; buffers: Buffer[] }>)(out, vector, 0);
  console.log("promisify(writev)", Object.keys(writev).join(), writev.bytesWritten, writev.buffers === vector);
}
closeSync(out);
{
  const handle = await fs.promises.open("handle.txt", "w+");
  await settle("handle.write(hello, 6)", () => handle.write(hello, 6));
  await settle("handle.write(hello, 5)", async () => (await handle.write(hello, 5)).bytesWritten);
  await settle("handle.write({ length: 3 }, 0, 'hex')", () => handle.write({ length: 3 } as never, 0, "hex" as never));
  await handle.close();
}

// writeSync takes the encoding from the argument after the position.
for (const args of [["abc", 0, "utf16le"], ["abc", null, "ucs2"], ["abc", undefined, "utf16le"], ["61626364", 0, "hex"], ["aGk=", null, "base64"], ["ÿ", 0, "latin1"], ["é", 0, "buffer"], ["aé中", 0, "buffer"], ["ab", "utf16le"], ["abc", 0], ["abc"]] as const) {
  const target = openSync("encoding.bin", "w");
  const written = (fs.writeSync as (...values: unknown[]) => number)(target, ...args);
  closeSync(target);
  console.log("writeSync", JSON.stringify(args), written, Array.from(readFileSync("encoding.bin")).join());
}

// exists, close, truncate, modes, mkdir and cp argument handling.
attempt("exists(path)", () => (fs.exists as (path: string) => void)("read.txt"));
console.log("exists callback", await new Promise((resolve) => fs.exists("read.txt", resolve)), await new Promise((resolve) => fs.exists("missing.txt", resolve)));
console.log("promisify(exists)", await promisify(fs.exists)("read.txt"), await promisify(fs.exists)("missing.txt"));
attempt("close(fd)", () => (fs.close as (fd: number) => void)(openSync("read.txt", "r")));
attempt("truncateSync(p, null)", () => fs.truncateSync("read.txt", null as never));
await settle("promises.truncate(p, null)", () => fs.promises.truncate("read.txt", null as never));
{
  const target = openSync("read.txt", "r+");
  attempt("ftruncateSync(fd, null)", () => fs.ftruncateSync(target, null as never));
  closeSync(target);
}
console.log("after truncation attempts", readFileSync("read.txt", "utf8"));
attempt("openSync with a String mode", () => openSync("mode.txt", "w", new String("755") as never));
fs.mkdirSync("modes");
attempt("chmodSync with a String mode", () => fs.chmodSync("modes", new String("755") as never));
attempt("chmodSync with mode 'x'", () => fs.chmodSync("modes", "x" as never));
for (const recursive of ["lalala", "", 1, {}, [], null, () => {}]) {
  attempt(`mkdirSync recursive ${typeof recursive} ${JSON.stringify(recursive)}`, () => fs.mkdirSync("never", { recursive } as never));
}
attempt("mkdirSync recursive symbol", () => fs.mkdirSync("never", { recursive: Symbol("test") } as never));
attempt("cp(a, b)", () => (fs.cp as (a: string, b: string) => void)("a", "b"));
attempt("new ReadStream(path, function)", () => typeof new (fs.ReadStream as unknown as new (...args: unknown[]) => object)("read.txt", function lol() {}));
attempt("new ReadStream(path, {})", () => typeof new (fs.ReadStream as unknown as new (...args: unknown[]) => object)("read.txt", {}));

// The module: a lazy enumerable promises getter and functions named after their keys.
const promisesDescriptor = Object.getOwnPropertyDescriptor(fs, "promises")!;
console.log("promises getter", typeof promisesDescriptor.get, promisesDescriptor.enumerable, fs.promises === (await import("node:fs/promises")).default);
console.log("misnamed functions", JSON.stringify(Object.keys(fs).filter((key) => !key.startsWith("File") && typeof (fs as unknown as Record<string, unknown>)[key] === "function" && ((fs as unknown as Record<string, { name: string }>)[key]).name !== key)));
await new Promise((resolve) => setTimeout(resolve, 20));
