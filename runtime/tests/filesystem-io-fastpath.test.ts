import { expect, test } from "bun:test";
import { FilesystemClient, createFilesystemConnection } from "../fs";

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
