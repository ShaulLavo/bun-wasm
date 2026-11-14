import { clock, type Clock } from "./safari-protocol";
import { decodeExit, NOTE_EXIT, NOTE_EXITSTATUS, NOTE_EXIT_DETAIL } from "./safari-exit-decode";

// The native bridge supplies these exact synchronous calls. Tests inject them;
// this module never imports FFI or executes a native call on the PC.
export type ExitSyscalls = {
  kqueue(): number;
  kevent64(fd: number, change: Uint8Array | null, event: Uint8Array, timeout: BigInt64Array): number;
  close(fd: number): number;
  errno(): number;
};
function raw(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { ident: String(view.getBigUint64(0, true)), filter: view.getInt16(8, true), flags: view.getUint16(10, true),
    fflags: view.getUint32(12, true), data: String(view.getBigInt64(16, true)), udata: String(view.getBigUint64(24, true)),
    ext: [String(view.getBigUint64(32, true)), String(view.getBigUint64(40, true))], hex: Buffer.from(bytes).toString("hex") };
}
export class NativeExitError extends Error {
  cleanup: unknown = null;
  constructor(message: string, readonly evidence: unknown) { super(message); }
}

export function openExit(system: ExitSyscalls, pid: number, now: () => Clock = clock) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid exact PID");
  const fd = system.kqueue();
  const createErrno = fd < 0 ? system.errno() : 0;
  if (fd < 0) throw new NativeExitError("kqueue failed", { count: fd, errno: createErrno, at: now() });
  let closed = false;
  let closeReceipt: { count: number; errno: number; dispatched: Clock; settled: Clock } | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    const dispatched = now();
    const count = system.close(fd);
    const failure = count < 0 ? system.errno() : 0;
    closeReceipt = { count, errno: failure, dispatched, settled: now() };
    if (count !== 0) throw new NativeExitError("close failed", closeReceipt);
  };
  const interest: "status-detail" = "status-detail";
  const change = new Uint8Array(48), event = new Uint8Array(48), timeout = new BigInt64Array(2);
  const view = new DataView(change.buffer);
  view.setBigUint64(0, BigInt(pid), true); view.setInt16(8, -5, true);
  view.setUint16(10, 0x41, true); view.setUint32(12, (NOTE_EXIT | NOTE_EXITSTATUS | NOTE_EXIT_DETAIL) >>> 0, true);
  const dispatched = now();
  const count = system.kevent64(fd, change, event, timeout);
  const callErrno = count < 0 ? system.errno() : 0;
  const settled = now(), receipt = raw(event);
  const registration = { interest, dispatched, settled, count, errno: count < 0 ? callErrno : Number(receipt.data), change: raw(change), receipt };
  if (count !== 1 || receipt.ident !== String(pid) || receipt.filter !== -5 || !(receipt.flags & 0x4000) || registration.errno !== 0) {
    const primary = new NativeExitError("registration failed", registration);
    try { close(); }
    catch (error) { primary.cleanup = error; }
    throw primary;
  }
  const poll = () => {
    if (closed) throw new Error("kqueue already closed");
    event.fill(0);
    const dispatched = now();
    const count = system.kevent64(fd, null, event, timeout);
    const failure = count < 0 ? system.errno() : 0;
    const settled = now();
    if (count < 0) throw new NativeExitError("kevent64 failed", { count, errno: failure, dispatched, settled, raw: raw(event) });
    if (count === 0) return { kind: "empty", dispatched, settled, count } as const;
    const observed = raw(event);
    const data = Number(observed.data);
    const evidence = { count, dispatched, settled, raw: observed };
    if (count !== 1 || observed.ident !== String(pid) || observed.filter !== -5 || observed.flags & 0x4000) throw new NativeExitError("invalid event", evidence);
    if (!(observed.fflags & NOTE_EXIT) || !Number.isSafeInteger(data) || (observed.fflags & NOTE_EXITSTATUS) && (data & 0x7f) === 0x7f) throw new NativeExitError("nonterminal or unrepresentable exit event", evidence);
    return { kind: "event", dispatched, settled, count, raw: observed, decoded: decodeExit(observed.fflags, data) } as const;
  };
  return { pid, interest, registration, poll, close, get closeReceipt() { return closeReceipt; } };
}
