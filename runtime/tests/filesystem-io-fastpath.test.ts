import { expect, test } from "bun:test";
import { FilesystemClient, createFilesystemConnection } from "../fs";
import { atomicHost } from "./fixtures/wasi-atomic-host";
import { fixedWriteSources } from "../fs/shared";

function fixture() {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  client.shared.register(0, { kind: "file", ino: 1, size: 4, mtime: 1 }, new Uint8Array([65, 66, 67, 68]));
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0);
  Atomics.store(capabilities, 2, 0);
  client.retain(0);
  client.call = () => { throw new Error("unexpected I/O RPC"); };
  return { client, cleanup: () => { client.dispose(); pair.server.port.close(); } };
}

test("retained read, write and append do not construct full file metadata", () => {
  const { client, cleanup } = fixture();
  client.shared.info = () => { throw new Error("full metadata on I/O path"); };
  try {
    expect(client.write(0, [new Uint8Array([90])], 0)).toBe(1);
    expect(client.append(0, [new Uint8Array([69])])).toEqual({ written: 1, offset: 5 });
    const bytes = new Uint8Array(5);
    expect(client.read(0, [bytes], 0)).toBe(5);
    expect(bytes).toEqual(new Uint8Array([90, 66, 67, 68, 69]));
  } finally { cleanup(); }
});

test("retained positioned writes and appends acquire one file lock each", () => {
  const { client, cleanup } = fixture();
  const compare = Atomics.compareExchange;
  let locks = 0;
  Atomics.compareExchange = ((...args: any[]) => {
    if (args[0] === client.shared.slots && args[1] === 20 && args[2] === 0) locks++;
    return Reflect.apply(compare, Atomics, args);
  }) as typeof Atomics.compareExchange;
  try {
    expect(client.write(0, [new Uint8Array([90])], 0)).toBe(1);
    expect(locks).toBe(1);
    locks = 0;
    expect(client.append(0, [new Uint8Array([69])])).toEqual({ written: 1, offset: 5 });
    expect(locks).toBe(1);
  } finally { Atomics.compareExchange = compare; cleanup(); }
});

test("warmed small retained reads reuse their staging bytes and iovec", () => {
  const { client, cleanup } = fixture();
  const read = client.shared.read.bind(client.shared);
  const buffers: ArrayBufferLike[] = [];
  const vectors: (readonly Uint8Array[])[] = [];
  client.shared.read = (...args) => {
    buffers.push(args[1][0]!.buffer);
    vectors.push(args[1]);
    return read(...args);
  };
  try {
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 3; i++) expect(client.read(0, [bytes], 0)).toBe(4);
    expect(buffers[1]).toBe(buffers[0]);
    expect(buffers[2]).toBe(buffers[0]);
    expect(vectors[1]).toBe(vectors[0]);
  } finally { cleanup(); }
});

test("reentrant guest copies cannot overwrite another read's leased staging bytes", () => {
  const { client, cleanup } = fixture();
  let entered = false;
  class ReentrantBytes extends Uint8Array {
    set(source: ArrayLike<number>, offset = 0): void {
      if (!entered) {
        entered = true;
        const nested = new Uint8Array(2);
        expect(client.read(0, [nested], 2)).toBe(2);
        expect(nested).toEqual(new Uint8Array([67, 68]));
      }
      super.set(source, offset);
    }
  }
  try {
    const first = new ReentrantBytes(2);
    const second = new Uint8Array(2);
    expect(client.read(0, [first, second], 0)).toBe(4);
    expect(Array.from(first).concat(Array.from(second))).toEqual([65, 66, 67, 68]);
  } finally { cleanup(); }
});

const emptyLayouts = [
  { name: "leading", lengths: [0, 2, 2] },
  { name: "middle", lengths: [2, 0, 2] },
  { name: "trailing", lengths: [2, 2, 0] },
  { name: "all-empty", lengths: [0, 0, 0] },
];
for (const { name, lengths } of emptyLayouts) {
  test(`retained read skips ${name} empty iovecs without losing bytes`, () => {
    const { client, cleanup } = fixture();
    try {
      const chunks = lengths.map(length => new Uint8Array(length).fill(99));
      const expected = name === "all-empty" ? [] : [65, 66, 67, 68];
      expect(client.read(0, chunks, 0)).toBe(expected.length);
      expect(chunks.flatMap(chunk => Array.from(chunk))).toEqual(expected);
    } finally { cleanup(); }
  });
  test(`WASI fd_read handles ${name} empty iovecs and advances only by copied bytes`, () => {
    const { client, cleanup } = fixture();
    const host = atomicHost(client, {});
    try {
      const fd = host.wasi.descriptors.open({ kind: "file", handle: 0, offset: 0, append: false }, (1n << 29n) - 1n, 0n);
      const chunks = lengths.map(length => new Uint8Array(length).fill(99));
      const expected = name === "all-empty" ? [] : [65, 66, 67, 68];
      host.iovecs(chunks);
      expect(host.calls.fd_read!(fd, 0, chunks.length, 1024)).toBe(0);
      expect(host.view().getUint32(1024, true)).toBe(expected.length);
      expect(Array.from(new Uint8Array(host.memory.buffer, 2048, expected.length))).toEqual(expected);
      expect(host.tell(fd)).toBe(expected.length);
      expect(host.errors).toEqual([]);
    } finally { host.wasi.descriptors.dispose(); cleanup(); }
  });
}

for (const operation of ["write", "append"] as const) for (const phase of ["before-lock", "during-copy"] as const) {
  test(`${operation} bounds growable source bytes consistently when growth happens ${phase}`, () => {
    const { client, cleanup } = fixture();
    const Constructor = SharedArrayBuffer as unknown as new (length: number, options: { maxByteLength: number }) => SharedArrayBuffer & { grow(length: number): void };
    // Nonzero source byteOffset must survive conversion to a fixed-length view.
    const buffer = new Constructor(2, { maxByteLength: 3 });
    const source = new Uint8Array(buffer, 1);
    source[0] = 90;
    const grow = () => { buffer.grow(3); source[1] = 91; };
    const mutate = client.shared.mutate.bind(client.shared);
    if (phase === "before-lock") client.shared.mutate = (...args) => {
      client.shared.mutate = mutate;
      grow();
      return mutate(...args);
    };
    class GrowingBytes extends Uint8Array {
      subarray(start?: number, end?: number): Uint8Array {
        grow();
        return super.subarray(start, end);
      }
    }
    const chunks = phase === "during-copy" ? [new GrowingBytes([88]), source] : [source];
    const total = phase === "during-copy" ? 2 : 1;
    try {
      if (operation === "append") {
        expect(client.append(0, chunks)).toEqual({ written: total, offset: 4 + total });
        const bytes = new Uint8Array(4 + total);
        expect(client.read(0, [bytes], 0)).toBe(bytes.length);
        expect(Array.from(bytes)).toEqual([65, 66, 67, 68].concat(phase === "during-copy" ? [88, 90] : [90]));
      } else {
        expect(client.write(0, chunks, 4 - total)).toBe(total);
        const bytes = new Uint8Array(4);
        expect(client.read(0, [bytes], 0)).toBe(4);
        expect(Array.from(bytes)).toEqual(phase === "during-copy" ? [65, 66, 88, 90] : [65, 66, 67, 90]);
        // No unreported source byte may leak into a later extension of the file.
        expect(client.resize(0, 5, false)).toBe(0);
        const tail = new Uint8Array(1).fill(99);
        expect(client.read(0, [tail], 4)).toBe(1);
        expect(tail[0]).toBe(0);
      }
    } finally { cleanup(); }
  });
}

test("ordinary and fixed shared write sources keep their original iovec and views", () => {
  const chunks = [new Uint8Array(2), new Uint8Array(new SharedArrayBuffer(2))];
  expect(fixedWriteSources(chunks)).toBe(chunks);
  expect(fixedWriteSources(chunks)[0]).toBe(chunks[0]);
  expect(fixedWriteSources(chunks)[1]).toBe(chunks[1]);
});
