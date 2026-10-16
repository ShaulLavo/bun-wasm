import type { Stream, Readiness } from "@bun-wasm/runtime/core";
import type { EngineNet } from "./net/host";
import type { SlotImpls } from "./net/trampoline";
export interface SpawnMeta {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}
export interface ChildTransport {
  budget: SharedArrayBuffer;
  slot: number;
  token: number;
  inheritedStdin?: boolean;
  pipes: SharedArrayBuffer[];
  control: SharedArrayBuffer;
  filesystem: { toChild: SharedArrayBuffer; toParent: SharedArrayBuffer } | null;
}
export interface FilesystemSync {
  capture(): string;
  commit(snapshot: string): void;
  merge(snapshot: string): void;
}
export const MAX_CHILDREN: number;
export function createProcessBudget(): SharedArrayBuffer;
export class SharedPipe {
  constructor(buffer?: SharedArrayBuffer, budget?: SharedArrayBuffer);
  buffer: SharedArrayBuffer;
  read(cap?: number): Uint8Array | number;
  write(bytes: Uint8Array): number;
  writeAll(bytes: Uint8Array): void;
  readBlocking(cap: number): Uint8Array | number;
  close(): void;
  readiness(): Readiness;
}
export function wasiPipe(pipe: SharedPipe, mode: "read" | "write", hooks?: { afterRead?(): void; beforeWrite?(): void }): Stream;
export function childTransport(transport: ChildTransport): {
  stdin: SharedPipe;
  stdout: SharedPipe;
  stderr: SharedPipe;
  receiveFilesystem(): string | null;
  sendFilesystem(snapshot: string): boolean;
  finish(code: number, snapshot?: string): void;
};
export class SubprocessHost {
  constructor(options: {
    budget?: SharedArrayBuffer;
    slot?: number;
    token?: number;
    stdin?: SharedArrayBuffer;
    launch(meta: SpawnMeta, transport: ChildTransport, onError: (error: unknown) => void): { terminate(): unknown };
    /** Return false when the inherited reader has closed. */
    output(fd: number, bytes: Uint8Array): void | boolean;
    filesystem?(): FilesystemSync;
    syncFilesystem?(): void;
  });
  budget: SharedArrayBuffer;
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
  dispose(): void;
  engineNet(net?: EngineNet): EngineNet;
  slots(net?: SlotImpls): SlotImpls;
}
