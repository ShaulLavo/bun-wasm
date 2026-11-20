import fs, { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";

// Bun keeps the buffers an fs call reads attached until the call completes: transfer()
// copies a pinned buffer instead of detaching it. Paths given as bytes are read when the
// call starts, before any option getter runs.
const fill = (byte: number) => new Uint8Array(new ArrayBuffer(8)).fill(byte);
const detachedAfterTransfer = (view: Uint8Array) => {
  const copy = view.buffer.transfer();
  return `${view.buffer.detached} copy ${copy.byteLength} ${new Uint8Array(copy)[0]}`;
};

{
  const fd = openSync("write.bin", "w");
  const buf = fill(0x44);
  const done = new Promise((resolve, reject) => fs.write(fd, buf, 0, 8, 0, (error, written) => error ? reject(error) : resolve(written)));
  console.log("write in flight", detachedAfterTransfer(buf));
  console.log("write wrote", await done, detachedAfterTransfer(buf));
  closeSync(fd);
  console.log("write file", readFileSync("write.bin", "latin1"));
}

{
  const fd = openSync("writev.bin", "w");
  const buf = fill(0x43);
  const done = new Promise((resolve, reject) => fs.writev(fd, [buf], 0, (error, written) => error ? reject(error) : resolve(written)));
  console.log("writev in flight", detachedAfterTransfer(buf));
  console.log("writev wrote", await done, detachedAfterTransfer(buf));
  closeSync(fd);
  console.log("writev file", readFileSync("writev.bin", "latin1"));
}

{
  const buf = fill(0x45);
  const pending = fs.promises.writeFile("promise.bin", buf);
  console.log("promises.writeFile in flight", detachedAfterTransfer(buf));
  await pending;
  console.log("promises.writeFile done", detachedAfterTransfer(buf), readFileSync("promise.bin", "latin1"));
}

{
  const buf = fill(0x46);
  const done = new Promise((resolve) => fs.writeFile("callback.bin", buf, resolve));
  console.log("writeFile in flight", detachedAfterTransfer(buf));
  console.log("writeFile error", await done, detachedAfterTransfer(buf), readFileSync("callback.bin", "latin1"));
}

{
  const bytes = new TextEncoder().encode("path.txt");
  const path = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  path.set(bytes);
  let detachedDuringOptions;
  await fs.promises.writeFile(path, "hello", {
    get flag() {
      path.buffer.transfer();
      detachedDuringOptions = path.buffer.detached;
      return "w";
    },
  });
  console.log("path pinned during options", detachedDuringOptions, readFileSync("path.txt", "utf8"));
}

// An unpinned buffer still detaches; a pinned one copies, to a new length too.
{
  const plain = new ArrayBuffer(4);
  plain.transfer();
  console.log("unpinned transfer detaches", plain.detached);
  const view = fill(0x47);
  const fd = openSync("lengths.bin", "w");
  const done = new Promise((resolve) => fs.write(fd, view, resolve));
  const longer = view.buffer.transfer(12);
  const shorter = view.buffer.transferToFixedLength(3);
  console.log("pinned copies", view.buffer.detached, longer.byteLength, Array.from(new Uint8Array(longer)).join(), shorter.byteLength, Array.from(new Uint8Array(shorter)).join());
  try {
    view.buffer.transfer(2n as unknown as number);
  } catch (error) {
    console.log("pinned BigInt length", (error as Error).name);
  }
  await done;
  closeSync(fd);
}

// After pins have been used, the methods still look like the engine's own.
for (const name of ["transfer", "transferToFixedLength"] as const) {
  const method = ArrayBuffer.prototype[name];
  const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, name)!;
  console.log(name, method.name, method.length, Function.prototype.toString.call(method).includes("[native code]"),
    descriptor.writable, descriptor.enumerable, descriptor.configurable, "prototype" in method);
}

// Paths given as bytes (Uint8Array, DataView, ArrayBuffer) are read before option getters.
const resizablePath = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.length, { maxByteLength: 1 << 16 });
  new Uint8Array(buffer).set(bytes);
  return buffer;
};
{
  const buffer = resizablePath("written.txt");
  writeFileSync(new Uint8Array(buffer), "sync-write", {
    get flag() {
      buffer.resize(0);
      return "w";
    },
  });
  console.log("writeFileSync", readFileSync("written.txt", "utf8"));
}
{
  const buffer = resizablePath("written.txt");
  const text = readFileSync(new DataView(buffer), {
    get encoding() {
      buffer.resize(0);
      return "utf8" as const;
    },
  });
  console.log("readFileSync", text);
}
{
  const buffer = resizablePath("made");
  mkdirSync(buffer as unknown as string, {
    get recursive() {
      buffer.resize(0);
      return true;
    },
  });
  console.log("mkdirSync", statSync("made").isDirectory());
}
{
  const buffer = resizablePath("written.txt");
  const pending = fs.promises.stat(new Uint8Array(buffer));
  buffer.resize(0);
  console.log("promises.stat", (await pending).size);
}
