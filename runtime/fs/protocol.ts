// Original shared-memory protocol. Ports schedule work; request/response bytes and completion
// state live in the SAB. The service never waits on a guest, including a terminated one.
// Guest browser-engine polyfills replace MessageChannel; transport endpoints must stay native.
const NativeMessageChannel = globalThis.MessageChannel;
export const HEADER = 32;
export const PAGE = 64 * 1024;
export const enum State { Pending, Complete, Cancelled, Failed, Overflow }
export class FilesystemError extends Error {
  constructor(public errno: number, message = `filesystem errno ${errno}`) { super(message); }
}
export interface FilesystemConnection {
  port: MessagePort;
  epoch: SharedArrayBuffer;
  signal: SharedArrayBuffer;
  /** This connection's revocation word, then its ancestors. Never reused. */
  revocations: SharedArrayBuffer[];
}
export type FilesystemIdentity = Omit<FilesystemConnection, "port">;
/** Guests can allocate a child identity while blocked; its controller creates the ports.
 * Firefox does not activate guest-created channels until that guest returns to its event loop.
 */
export function createFilesystemIdentity(parent?: FilesystemIdentity): FilesystemIdentity {
  return {
    epoch: parent?.epoch ?? new SharedArrayBuffer(4),
    // Every descendant waits here too, so root revocation can wake blocked guests after a crash.
    signal: parent?.signal ?? new SharedArrayBuffer(4),
    revocations: [new SharedArrayBuffer(4)].concat(parent?.revocations ?? []),
  };
}
export function connectFilesystemIdentity(identity: FilesystemIdentity) {
  const channel = new NativeMessageChannel();
  return { client: { ...identity, port: channel.port1 }, server: { ...identity, port: channel.port2 } };
}
export function createFilesystemConnection(parent?: FilesystemIdentity) {
  return connectFilesystemIdentity(createFilesystemIdentity(parent));
}
export function isRevoked(connection: FilesystemIdentity): boolean {
  return connection.revocations.some(buffer => Atomics.load(new Int32Array(buffer), 0) !== 0);
}
export function revokeFilesystem(connection: FilesystemIdentity): void {
  Atomics.store(new Int32Array(connection.revocations[0]!), 0, 1);
  wake(connection);
}
export function wake(connection: FilesystemIdentity): void {
  const signal = new Int32Array(connection.signal);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function pack(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, (_key, item) => item === undefined ? { $undefined: true } : item instanceof Map ? { $map: Array.from(item) } : item));
}
export function unpack(bytes: Uint8Array): any {
  // Revivers returning undefined delete object properties, which is correct for resolved paths.
  return JSON.parse(decoder.decode(bytes.buffer instanceof SharedArrayBuffer ? bytes.slice() : bytes), (_key, item) => item?.$undefined ? undefined : item?.$map ? new Map(item.$map) : item);
}
export type RequestMessage = { id: number; buffer: SharedArrayBuffer } | { connect: FilesystemConnection } | { sweep: true } | { discard: number };
export function errno(error: unknown): number {
  if (error instanceof FilesystemError) return error.errno;
  if (error instanceof RangeError) return 27; // EFBIG
  return 29; // EIO, never invent ENOENT for an internal failure.
}
