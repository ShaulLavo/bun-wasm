import type { Stream, Readiness } from "@bun-wasm/runtime/core";
import type { EngineNet } from "./net/host";
import type { SlotImpls } from "./net/trampoline";
export interface SpawnMeta {
  executable?: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  job?: number;
  stdin?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}
export interface ChildTransport {
  pid: number;
  parentPid: number;
  jobId: number;
  identity: SharedArrayBuffer;
  interrupt: SharedArrayBuffer;
  requestedSignal: SharedArrayBuffer;
  outcome: SharedArrayBuffer;
  budget: SharedArrayBuffer;
  slot: number;
  token: number;
  inheritedStdin?: boolean;
  pipes: SharedArrayBuffer[];
  control: SharedArrayBuffer;
}
export interface ChildWorker {
  /** Revoke access before requesting physical worker termination. */
  revoke?(): void;
  terminate(): unknown;
}
export interface SubprocessOptions {
  budget?: SharedArrayBuffer;
  identity?: SharedArrayBuffer;
  pid?: number;
  jobId?: number;
  slot?: number;
  token?: number;
  stdin?: SharedArrayBuffer;
  /** Shared process capability revocation, including roots without a budget slot. */
  revoked?(): boolean;
  onChildClose?(pid: number): void;
  launch(meta: SpawnMeta, transport: ChildTransport, onError: (error: unknown) => void): ChildWorker;
  /** Return false when the inherited reader has closed. */
  output(fd: number, bytes: Uint8Array): void | boolean;
}
export const MAX_CHILDREN: number;
/** Slot 14 selector: completed ordinary exit = 0, selected signal = signal number, pending = -2. */
export const CHILD_FINAL_SIGNAL = 3;
export function createProcessBudget(): SharedArrayBuffer;
export class SharedPipe {
  constructor(buffer?: SharedArrayBuffer, budget?: SharedArrayBuffer);
  buffer: SharedArrayBuffer;
  cells: Int32Array;
  read(cap?: number): Uint8Array | number;
  write(bytes: Uint8Array): number;
  writeAll(bytes: Uint8Array): void;
  readBlocking(cap: number): Uint8Array | number;
  close(): void;
  readiness(): Readiness;
}
export function wasiPipe(pipe: SharedPipe, mode: "read" | "write"): Stream;
export function releaseProcessSlot(transport: Pick<ChildTransport, "budget" | "slot" | "token">): void;
export function childTransport(transport: ChildTransport): {
  stdin: SharedPipe;
  stdout: SharedPipe;
  stderr: SharedPipe;
  finish(code: number, signal?: number): void;
};
export class SubprocessHost {
  constructor(options: SubprocessOptions);
  budget: SharedArrayBuffer;
  identity: SharedArrayBuffer;
  attach(memory: WebAssembly.Memory): void;
  spawn(meta: string): number;
  pipe(id: number, fd: number): number;
  wait(id: number): number;
  read(id: number, cap?: number): Uint8Array | number;
  write(id: number, bytes: Uint8Array): number;
  close(id: number): number;
  kill(id: number, signal?: number): number;
  owns(id: number): boolean;
  poll(timeout?: number): number;
  detach(): void;
  dispose(): void;
  engineNet(net?: EngineNet): EngineNet;
  slots(net?: SlotImpls): SlotImpls;
}
