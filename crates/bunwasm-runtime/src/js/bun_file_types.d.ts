declare namespace BunWasm {
  interface Native {
    open(path: string, flags: string): number;
    close(fd: number): void;
    read(fd: number, length: number, position: number): Uint8Array<ArrayBuffer>;
    fstat(fd: number): { size: number; mode: number; mtimeMs: number };
  }
  interface Internal {
    require(name: "streams"): { ReadableStream: typeof ReadableStream };
  }
}
