export const NOTE_EXIT = 0x80000000;
export const NOTE_EXITSTATUS = 0x04000000;
export const NOTE_EXIT_DETAIL = 0x02000000;
export const NOTE_EXIT_MEMORY = 0x00020000;

export function decodeExit(fflags: number, data: number) {
  const statusAvailable = Boolean(fflags & NOTE_EXITSTATUS);
  const detailAvailable = Boolean(fflags & NOTE_EXIT_DETAIL);
  const status = statusAvailable ? data & 0xffff : null;
  const signal = status === null || (status & 0x7f) === 0 ? null : status & 0x7f;
  return {
    exited: Boolean(fflags & NOTE_EXIT), fflags, data, statusAvailable, detailAvailable,
    waitStatus: status, signal,
    exitCode: status === null || signal !== null ? null : (status >> 8) & 0xff,
    kernelMemoryExit: detailAvailable ? Boolean(data & NOTE_EXIT_MEMORY) : null,
    decryptFailure: detailAvailable ? Boolean(data & 0x00010000) : null,
    codeSigningFailure: detailAvailable ? Boolean(data & 0x00040000) : null,
    unknownDetailBits: detailAvailable ? data & ~0x0007ffff : null,
  };
}
