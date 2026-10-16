import { writeSync } from "node:fs";

const pause = new Int32Array(new SharedArrayBuffer(4));

function writeBlocking(fd: number, bytes: Uint8Array): number {
  for (;;) {
    try {
      return writeSync(fd, bytes);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code === "EINTR") continue;
      if (error.code !== "EAGAIN" && error.code !== "EWOULDBLOCK") throw error;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

export function writeOutput(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeBlocking(fd, bytes.subarray(offset));
    if (written === 0) throw new Error("stdio write made no progress");
    offset += written;
  }
}

export function writeStdio(fd: number, chunks: readonly Uint8Array[]): number {
  const chunk = chunks.find(chunk => chunk.length > 0);
  if (!chunk) return 0;
  try {
    return writeBlocking(fd, chunk);
  } catch (error) {
    const errno = error instanceof Error && "code" in error && error.code === "EPIPE" ? 64 : 29;
    return -errno;
  }
}

export function forwardOutput(fd: number, bytes: Uint8Array): boolean {
  try {
    writeOutput(fd, bytes);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPIPE") return false;
    throw error;
  }
}
