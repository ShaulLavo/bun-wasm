// Waffle's `runtime_fs.path_probe` for the Node test host (Waffle docs/host-abi.md, "Path probe").
// Speed doesn't matter here, so each pathname is one call to the guest-facing
// `path_filestat_get` with the follow flag: the answer is a following stat's by construction.

const BADF = 8, FAULT = 21, INVAL = 28, NOTDIR = 54, NOTCAPABLE = 76;
const PROBE_LIMIT = 64;
const FILESTAT_SIZE = 64, FILETYPE_OFFSET = 16;
const FILETYPE: Record<number, number> = { 1: 4, 2: 3 }; // regular file, directory
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

type FilestatGet = (fd: number, flags: number, path: number, len: number, out: number) => number;

/** A probe list: one to PROBE_LIMIT pathnames, each ended by a NUL, or undefined. */
function probeNames(bytes: Uint8Array): string[] | undefined {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) return undefined;
  const names: string[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (names.length === PROBE_LIMIT) return undefined;
    try { names.push(decoder.decode(bytes.subarray(start, i))); } catch { return undefined; }
    start = i + 1;
  }
  return names;
}

/** `runtime_fs.path_probe` over `filestat`, read when called so it is the final wrapped import. */
export function nodePathProbe(memory: () => WebAssembly.Memory, filestat: () => FilestatGet) {
  return (fd: number, paths: number, len: number, kind: number, found: number): number => {
    const size = memory().buffer.byteLength;
    paths >>>= 0; len >>>= 0; found >>>= 0;
    if (paths + len > size || found + 4 > size) return FAULT;
    const names = probeNames(new Uint8Array(memory().buffer, paths, len));
    const filetype = FILETYPE[kind >>> 0];
    if (names === undefined || filetype === undefined) return INVAL;
    const stat = (name: string) => statKind(memory, filestat(), fd, name);
    // The descriptor itself must be a directory this process can stat paths from.
    const self = stat(".");
    if (self === BADF || self === NOTDIR || self === NOTCAPABLE) return self;
    const index = names.findIndex(name => name !== "" && !name.startsWith("/") && stat(name) === -filetype);
    new DataView(memory().buffer).setUint32(found, index < 0 ? 0xffffffff : index, true);
    return 0;
  };
}

/** `-filetype` of what `name` names from `fd`, links followed, or the stat's positive errno. The
 * path and the filestat go at the top of guest memory, which is restored afterwards: the guest is
 * one agent blocked in this call, so it never sees that region. */
function statKind(memory: () => WebAssembly.Memory, filestat: FilestatGet, fd: number, name: string): number {
  const encoded = encoder.encode(name + "\0");
  const bytes = new Uint8Array(memory().buffer);
  const start = bytes.length - encoded.length - FILESTAT_SIZE;
  if (start < 0) return FAULT;
  const saved = bytes.slice(start);
  bytes.set(encoded, start);
  try {
    const errno = filestat(fd, 1, start, encoded.length - 1, start + encoded.length);
    if (errno !== 0) return errno;
    return -new Uint8Array(memory().buffer)[start + encoded.length + FILETYPE_OFFSET]!;
  } finally {
    new Uint8Array(memory().buffer).set(saved, start);
  }
}
