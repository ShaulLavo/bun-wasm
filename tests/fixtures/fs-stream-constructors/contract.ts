import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { inherits } from "node:util";

type Filesystem = typeof import("node:fs");

function descriptor(stream: object) {
  assert.ok("fd" in stream);
  return stream.fd;
}

async function closed(stream: Readable | Writable) {
  await new Promise<void>(resolve => { stream.once("close", resolve); });
}

export async function verifyFilesystemStreams(fs: Filesystem, root: string, streams = { Readable, Writable }) {
  assert.equal(typeof fs.ReadStream, "function");
  assert.equal(typeof fs.WriteStream, "function");
  assert.equal(Reflect.get(fs, "FileReadStream"), fs.ReadStream);
  assert.equal(Reflect.get(fs, "FileWriteStream"), fs.WriteStream);
  assert.ok(fs.ReadStream.prototype instanceof streams.Readable);
  assert.ok(fs.WriteStream.prototype instanceof streams.Writable);

  const path = join(root, "stream.txt");
  const output = fs.createWriteStream(path, { highWaterMark: 2 });
  const outputClosed = closed(output);
  let writeFd: number | undefined;
  output.once("open", fd => { writeFd = fd; });
  const order: string[] = [];
  output.on("finish", () => order.push("finish"));
  output.on("close", () => order.push("close"));
  assert.ok(output instanceof fs.WriteStream);
  assert.equal(output.write(Buffer.from("abcd")), false);
  output.end("é");
  await outputClosed;
  assert.equal(fs.readFileSync(path, "utf8"), "abcdé");
  assert.equal(output.bytesWritten, 6);
  assert.deepEqual(order, ["finish", "close"]);
  assert.equal(output.destroyed, true);
  assert.equal(descriptor(output), null);
  assert.equal(typeof writeFd, "number");
  assert.ok(typeof writeFd === "number");
  const savedWriteFd = writeFd;
  assert.throws(() => fs.fstatSync(savedWriteFd), { code: "EBADF" });

  const input = fs.createReadStream(path, { highWaterMark: 2, start: 1, end: 4 });
  const inputClosed = closed(input);
  const chunks: Buffer[] = [];
  input.on("data", chunk => { assert.ok(Buffer.isBuffer(chunk)); chunks.push(chunk); });
  await inputClosed;
  assert.ok(input instanceof fs.ReadStream);
  assert.equal(Buffer.concat(chunks).toString("hex"), Buffer.from("bcdé").subarray(0, 4).toString("hex"));
  assert.ok(chunks.length > 1);
  assert.equal(input.bytesRead, 4);
  assert.equal(descriptor(input), null);

  const encoded = fs.createReadStream(path, { highWaterMark: 1, encoding: "utf8" });
  let text = "";
  for await (const chunk of encoded) text += chunk;
  assert.equal(text, "abcdé");
  assert.equal(encoded.destroyed, true);

  const ranged = fs.createReadStream(path, { end: Infinity });
  const rangeClosed = closed(ranged);
  ranged.resume();
  await rangeClosed;
  const hexPath = join(root, "hex.txt");
  const hex = fs.createWriteStream(hexPath, { encoding: "hex" });
  const hexClosed = closed(hex);
  hex.end("c3a9");
  await hexClosed;
  assert.equal(fs.readFileSync(hexPath, "utf8"), "é");
  await borrowedDescriptor(fs, path);
  await inheritedStreams(fs, path, root);
  await errorAndDestroy(fs, path, root);
}

async function inheritedStreams(fs: Filesystem, path: string, root: string) {
  function WrappedRead(this: import("node:fs").ReadStream, file: string, options: object) {
    Reflect.apply(fs.ReadStream, this, [file, options]);
  }
  function WrappedWrite(this: import("node:fs").WriteStream, file: string) {
    Reflect.apply(fs.WriteStream, this, [file]);
  }
  inherits(WrappedRead, fs.ReadStream);
  inherits(WrappedWrite, fs.WriteStream);
  const input: unknown = Reflect.construct(WrappedRead, [path, { highWaterMark: 2 }]);
  const target = join(root, "piped.txt");
  const output: unknown = Reflect.construct(WrappedWrite, [target]);
  assert.ok(output instanceof fs.WriteStream);
  const done = closed(output);
  assert.ok(input instanceof fs.ReadStream && input instanceof WrappedRead);
  assert.ok(output instanceof fs.WriteStream && output instanceof WrappedWrite);
  input.pipe(output);
  await done;
  assert.equal(fs.readFileSync(target, "utf8"), "abcdé");
  assert.equal(input.destroyed, true);
  assert.equal(output.destroyed, true);
}

async function errorAndDestroy(fs: Filesystem, path: string, root: string) {
  const missing = join(root, "missing", "file");
  for (const method of [fs.createReadStream, fs.createWriteStream]) {
    const stream = method(missing);
    const done = closed(stream);
    const errors: unknown[] = [];
    stream.on("error", error => errors.push(error));
    await done;
    assert.equal(errors.length, 1);
    assert.ok(errors[0] && typeof errors[0] === "object" && "code" in errors[0]);
    assert.equal(errors[0].code, "ENOENT");
    assert.equal(stream.destroyed, true);
    assert.equal(descriptor(stream), null);
  }
  const denied = fs.createWriteStream(path, { flags: "r" });
  const deniedClosed = closed(denied);
  const deniedErrors: unknown[] = [];
  denied.on("error", error => deniedErrors.push(error));
  denied.end("forbidden");
  await deniedClosed;
  assert.equal(deniedErrors.length, 1);
  assert.ok(deniedErrors[0] && typeof deniedErrors[0] === "object" && "code" in deniedErrors[0]);
  assert.equal(deniedErrors[0].code, "EBADF");
  assert.equal(descriptor(denied), null);
  const input = fs.createReadStream(path, { highWaterMark: 1 });
  const done = closed(input);
  input.once("data", () => input.destroy());
  input.resume();
  await done;
  assert.equal(input.destroyed, true);
  assert.equal(descriptor(input), null);
  const premature = fs.createWriteStream(join(root, "destroyed.txt"));
  const prematureClosed = closed(premature);
  premature.destroy();
  await prematureClosed;
  assert.equal(descriptor(premature), null);
  assert.equal(premature.destroyed, true);
  const reader = fs.createReadStream(path);
  const readerClosed = closed(reader);
  reader.close();
  await readerClosed;
  assert.equal(descriptor(reader), null);
  assert.throws(() => fs.createReadStream(path, { start: 4, end: 2 }), { code: "ERR_OUT_OF_RANGE" });
  const append = fs.createWriteStream(path, { flags: "a" });
  const appended = once(append, "close");
  append.end("!");
  await appended;
  assert.equal(fs.readFileSync(path, "utf8"), "abcdé!");
}

async function borrowedDescriptor(fs: Filesystem, path: string) {
  const fd = fs.openSync(path, "r");
  const input = fs.createReadStream(path, { fd, autoClose: false });
  const ended = once(input, "end");
  input.resume();
  await ended;
  assert.equal(descriptor(input), fd);
  assert.equal(fs.fstatSync(fd).size, 6);
  const done = closed(input);
  input.destroy();
  await done;
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
}
