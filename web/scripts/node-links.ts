// Symbolic links in the guest's namespace for Node's WASI (uvwasi).
//
// uvwasi refuses to create a symlink with an absolute target, follows an absolute final link
// against its preopen, and lets the host kernel follow every intermediate link: a relative link
// that climbs out of a preopen reaches host files. Here every path call is resolved first, the
// way Linux would inside the guest namespace: an absolute target restarts at guest `/`, `..`
// stops there, and at most 40 links are followed. uvwasi then receives the deepest preopen
// holding the result and a relative path with no link left for the kernel to follow. Links are
// stored as the guest wrote them. Node has no `openat2(RESOLVE_BENEATH)`, so a link swapped in
// by another process between this walk and uvwasi's call is the one gap left.
// docs/bun-patches/node-wasi-guest-symlinks.md describes the contract.
import { lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";

type Preview1 = Record<string, (...args: never[]) => number>;
type Call = (...args: unknown[]) => number;

const BADF = 8, EXIST = 20, FAULT = 21, ILSEQ = 25, LOOP = 32, NAMETOOLONG = 37, NOENT = 44, NOTDIR = 54, PERM = 63;
const O_CREAT = 1, O_EXCL = 4;
const MAX_LINKS = 40;
const PATH_LIMIT = 32 << 10;
const ERRNO: Record<string, number> = {
  EACCES: 2, EBADF: BADF, EBUSY: 10, EEXIST: 20, EINVAL: 28, EIO: 29, EISDIR: 31, ELOOP: LOOP,
  ENAMETOOLONG: NAMETOOLONG, ENOENT: NOENT, ENOSPC: 51, ENOTDIR: NOTDIR, ENOTEMPTY: 55, EPERM: PERM,
  EROFS: 69, EXDEV: 75,
};

/** A path argument: positions of its descriptor, pointer and length, and of lookup flags whose
 * bit 0 follows a final link. */
interface PathArg { fd: number; ptr: number; len: number; flags?: number }
/** Outputs are (pointer position, size) or, for a buffer, (pointer position, length position). */
interface Op {
  paths: readonly PathArg[]; output?: readonly [at: number, size: number]; buffer?: readonly [at: number, len: number];
  /** path_open: its oflags sit at position 4, and a final link it doesn't follow is refused here. */
  open?: true;
}

const one = (fd: number, ptr: number, len: number, flags?: number): PathArg => ({ fd, ptr, len, flags });
const OPS: Record<string, Op> = {
  path_create_directory: { paths: [one(0, 1, 2)] },
  path_filestat_get: { paths: [one(0, 2, 3, 1)], output: [4, 64] },
  path_filestat_set_times: { paths: [one(0, 2, 3, 1)] },
  path_link: { paths: [one(0, 2, 3, 1), one(4, 5, 6)] },
  path_open: { paths: [one(0, 2, 3, 1)], output: [8, 4], open: true },
  path_readlink: { paths: [one(0, 1, 2)], output: [5, 4], buffer: [3, 4] },
  path_remove_directory: { paths: [one(0, 1, 2)] },
  path_rename: { paths: [one(0, 1, 2), one(3, 4, 5)] },
  path_unlink_file: { paths: [one(0, 1, 2)] },
};

interface Mount { guest: string; host: string; fd: number }
interface Resolved { mount: Mount; relative: string; guest: string }
type Kind = { kind: "missing" | "directory" | "other" } | { kind: "link"; target: string };

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** A walk mark: never a component, since `parts` drops every `.`. */
const DIRECTORY = ".";

/** Whether `path` must name a directory: it ends in `/` or `/.`, or is `.`. */
function namesDirectory(path: string): boolean {
  return path.endsWith("/") || path === "." || path.endsWith("/.");
}

function parts(path: string): string[] {
  return path.split("/").filter(part => part && part !== ".");
}

/** The guest path of `path` opened from `base`, unresolved. */
function joinGuest(base: string, path: string): string {
  if (path.startsWith("/")) return path;
  const joined = [base.replace(/\/+$/, "")].concat(parts(path)).join("/");
  return joined || "/";
}

function errnoOf(error: unknown): number {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return ERRNO[code] ?? 29;
}

class GuestNamespace {
  readonly mounts: Mount[];

  constructor(preopens: Record<string, string>) {
    this.mounts = Object.entries(preopens).map(([guest, host], index) => ({
      guest: guest.replace(/(.)\/+$/, "$1"), host: realpathSync.native(host), fd: 3 + index,
    })).filter(mount => mount.guest.startsWith("/"));
  }

  /** The deepest mount holding a normalized absolute guest path, and the rest of the path. */
  mount(path: string): { mount: Mount; rest: string } | undefined {
    let best: { mount: Mount; rest: string } | undefined;
    for (const mount of this.mounts) {
      const prefix = mount.guest === "/" ? "" : mount.guest;
      if (path !== prefix && !path.startsWith(prefix + "/")) continue;
      if (best && best.mount.guest.length >= mount.guest.length) continue;
      best = { mount, rest: path.slice(prefix.length).replace(/^\/+/, "") };
    }
    return best;
  }

  host(path: string): string | undefined {
    const found = this.mount(path);
    if (!found) return undefined;
    return found.rest ? `${found.mount.host}/${found.rest}` : found.mount.host;
  }

  kind(path: string): Kind {
    // A nested mount makes its ancestors directories in the guest namespace.
    if (this.mounts.some(mount => mount.guest.length > path.length && mount.guest.startsWith(path === "/" ? "/" : path + "/")))
      return { kind: "directory" };
    const host = this.host(path);
    if (host === undefined) return { kind: "missing" };
    const stat = (() => { try { return lstatSync(host, { throwIfNoEntry: false }); } catch { return undefined; } })();
    if (!stat) return { kind: "missing" };
    if (stat.isDirectory()) return { kind: "directory" };
    if (!stat.isSymbolicLink()) return { kind: "other" };
    try { return { kind: "link", target: readlinkSync(host, "utf8") }; } catch { return { kind: "missing" }; }
  }

  /** Resolve `path` from guest directory `start` as Linux would inside the guest namespace. With
   * `directories`, a path or link target ending in `/` or `/.` (or being `.`) makes the
   * component before it a directory, as realpath(3) requires; a `DIRECTORY` mark stands for it. */
  resolve(start: string, path: string, follow: boolean, directories = false): Resolved | number {
    follow ||= path.endsWith("/");
    const pending = (path.startsWith("/") ? [] : parts(start)).concat(parts(path));
    if (directories && namesDirectory(path)) pending.push(DIRECTORY);
    pending.reverse();
    const current: string[] = [];
    let links = 0;
    while (pending.length) {
      const part = pending.pop()!;
      // The component before a mark is no longer last, so it must be a directory.
      if (part === DIRECTORY) continue;
      if (part === "..") { current.pop(); continue; }
      current.push(part);
      const last = !pending.length;
      if (last && !follow) break;
      const found = this.kind("/" + current.join("/"));
      if (found.kind === "link") {
        if (++links > MAX_LINKS) return LOOP;
        current.pop();
        if (found.target.startsWith("/")) current.length = 0;
        if (directories && namesDirectory(found.target)) pending.push(DIRECTORY);
        for (const next of parts(found.target).reverse()) pending.push(next);
        continue;
      }
      if (!last && found.kind === "missing") return NOENT;
      if (!last && found.kind === "other") return NOTDIR;
    }
    const guest = "/" + current.join("/");
    const found = this.mount(guest);
    if (!found) return NOENT;
    let relative = found.rest || ".";
    if (path.endsWith("/") && relative !== ".") relative += "/";
    return { mount: found.mount, relative, guest };
  }

  /** Whether uvwasi can take `path` from preopen `fd` unchanged: no `..`, no absolute path, no
   * link in the parent chain, and no final link to follow. Another directory's recorded path
   * may be stale (another process can rename it), so its calls are always resolved here. */
  direct(fd: number, start: string, path: string, follow: boolean): boolean {
    if (path.startsWith("/") || parts(path).includes("..")) return false;
    const guest = joinGuest(start, path);
    // Only when this preopen is the deepest one holding the path, so nested preopens agree.
    if (this.mount(guest)?.mount.fd !== fd) return false;
    const parent = guest.slice(0, guest.lastIndexOf("/")) || "/";
    const host = this.host(parent);
    if (host === undefined) return false;
    try { if (realpathSync.native(host) !== host) return false; } catch { return false; }
    if (!follow && !path.endsWith("/")) return true;
    const final = this.host(guest);
    if (final === undefined) return false;
    try { return !lstatSync(final, { throwIfNoEntry: false })?.isSymbolicLink(); } catch { return false; }
  }

  /** uvwasi's path_open never passes O_NOFOLLOW to the kernel, so a final link it isn't to follow
   * is answered here: ELOOP, or EEXIST for O_CREAT|O_EXCL on anything already there. */
  refuseFinal(guest: string, exclusive: boolean): number {
    const host = this.host(guest);
    if (host === undefined) return 0;
    const stat = (() => { try { return lstatSync(host, { throwIfNoEntry: false }); } catch { return undefined; } })();
    if (!stat) return 0;
    if (exclusive) return EXIST;
    return stat.isSymbolicLink() ? LOOP : 0;
  }
}

/** Guest memory access for one call: strings in, resolved paths out through a saved region. */
class Memory {
  private readonly memory: () => WebAssembly.Memory;
  constructor(memory: () => WebAssembly.Memory) { this.memory = memory; }
  bytes() { return new Uint8Array(this.memory().buffer); }
  string(ptr: number, len: number): string | number {
    const bytes = this.bytes();
    if (ptr < 0 || len < 0 || ptr + len > bytes.length) return FAULT;
    try { return decoder.decode(bytes.subarray(ptr, ptr + len)); } catch { return ILSEQ; }
  }
  inside(ptr: number, len: number) { return ptr >= 0 && len >= 0 && ptr + len <= this.bytes().length; }
  /** Run `call` with `texts` written at the end of guest memory, restoring those bytes after.
   * The guest is one agent blocked in this call, so it never observes the region. */
  borrow(texts: readonly string[], outputs: readonly (readonly [number, number])[], call: (ptrs: number[]) => number): number {
    // Node's WASI reads a followed path up to a NUL, past its length: terminate each one.
    const encoded = texts.map(text => encoder.encode(text + "\0"));
    const total = encoded.reduce((sum, bytes) => sum + bytes.length, 0);
    if (encoded.some(bytes => bytes.length > PATH_LIMIT)) return NAMETOOLONG;
    const memory = this.bytes();
    const start = this.region(memory.length, total, outputs);
    if (start === undefined) return FAULT;
    const saved = memory.slice(start, start + total);
    const ptrs: number[] = [];
    let at = start;
    for (const bytes of encoded) { memory.set(bytes, at); ptrs.push(at); at += bytes.length; }
    try { return call(ptrs); } finally { this.bytes().set(saved, start); }
  }
  /** The top of memory, or just below an output, whichever misses every output. */
  private region(size: number, total: number, outputs: readonly (readonly [number, number])[]): number | undefined {
    const candidates = [size - total].concat(outputs.map(([at]) => at - total));
    return candidates.find(start => start >= 0 && outputs.every(([at, length]) => at + length <= start || at >= start + total));
  }
}

/** realpath(3) in the guest namespace from a Node WASI descriptor (Waffle's
 * `runtime_fs.path_realpath`, docs/host-abi.md): the absolute guest path, or a WASI errno. */
export type NodeRealpath = (fd: number, path: string) => string | number;

/** Wrap uvwasi's path calls (taking Node WASI descriptors) to resolve in the guest namespace. */
export function installNodeLinks(wasi: Preview1, memory: () => WebAssembly.Memory, preopens: Record<string, string>): NodeRealpath {
  const namespace = new GuestNamespace(preopens);
  const guest = new Memory(memory);
  const paths = new Map(namespace.mounts.map(mount => [mount.fd, mount.guest]));
  const original = wasi as unknown as Record<string, Call>;
  for (const [name, op] of Object.entries(OPS)) {
    const call = original[name];
    if (!call) continue;
    original[name] = (...args: unknown[]) => {
      const result = resolvedCall(namespace, guest, paths, op, call, args);
      if (typeof result === "number") return result;
      if (name === "path_open") return recordOpen(guest, paths, args, result);
      if (name === "path_rename") return recordRename(paths, result);
      return result.errno;
    };
  }
  const symlink = original.path_symlink;
  if (symlink) original.path_symlink = (...args: unknown[]) => createLink(namespace, guest, paths, symlink, args);
  const close = original.fd_close;
  if (close) original.fd_close = (...args: unknown[]) => {
    const result = close(...args);
    if (result === 0) paths.delete(args[0] as number);
    return result;
  };
  return (fd, path) => realpath(namespace, paths, fd, path);
}

function realpath(namespace: GuestNamespace, paths: Map<number, string>, fd: number, path: string): string | number {
  const start = paths.get(fd);
  if (start === undefined) return BADF;
  if (path.startsWith("/")) return PERM;
  if (namespace.kind(joinGuest(start, ".")).kind !== "directory") return NOTDIR;
  const resolved = namespace.resolve(start, path, true, true);
  if (typeof resolved === "number") return resolved;
  return namespace.kind(resolved.guest).kind === "missing" ? NOENT : resolved.guest;
}

/** A call's errno and the guest paths of its path arguments. */
interface Outcome { errno: number; guests?: string[] }

/** One call with its paths resolved; an errno, or the call's outcome and its first guest path. */
function resolvedCall(namespace: GuestNamespace, guest: Memory, paths: Map<number, string>, op: Op, call: Call, args: unknown[]): number | Outcome {
  const texts: string[] = [];
  const guests: string[] = [];
  const next = args.slice();
  for (const arg of op.paths) {
    const start = paths.get(args[arg.fd] as number);
    const path = guest.string(args[arg.ptr] as number, args[arg.len] as number);
    if (typeof path === "number") return path;
    // An empty path names nothing (ENOENT); uvwasi answers it.
    if (start === undefined || !path) return { errno: call(...args) };
    // O_CREAT|O_EXCL never follows a final link, whatever the lookup flags say.
    const exclusive = op.open === true && ((args[4] as number) & (O_CREAT | O_EXCL)) === (O_CREAT | O_EXCL);
    const follow = !exclusive && (arg.flags !== undefined && ((args[arg.flags] as number) & 1) === 1 || path.endsWith("/"));
    if (arg.flags !== undefined && follow) next[arg.flags] = (args[arg.flags] as number) | 1;
    const direct = namespace.direct(args[arg.fd] as number, start, path, follow);
    const resolved = direct ? undefined : namespace.resolve(start, path, follow);
    if (typeof resolved === "number") return resolved;
    const target = resolved?.guest ?? joinGuest(start, path);
    const refused = op.open && !follow ? namespace.refuseFinal(target, exclusive) : 0;
    if (refused) return refused;
    guests.push(target);
    texts.push(resolved?.relative ?? "");
    if (resolved) next[arg.fd] = resolved.mount.fd;
  }
  if (texts.every(text => !text)) return { errno: call(...next), guests };
  const outputs: (readonly [number, number])[] = [];
  if (op.output) outputs.push([args[op.output[0]] as number, op.output[1]]);
  if (op.buffer) outputs.push([args[op.buffer[0]] as number, args[op.buffer[1]] as number]);
  if (outputs.some(([at, size]) => !guest.inside(at, size))) return FAULT;
  const errno = guest.borrow(texts.filter(Boolean), outputs, ptrs => {
    let index = 0;
    op.paths.forEach((arg, slot) => {
      if (!texts[slot]) return;
      next[arg.ptr] = ptrs[index++];
      next[arg.len] = encoder.encode(texts[slot]).length;
    });
    return call(...next);
  });
  return { errno, guests };
}

function recordOpen(guest: Memory, paths: Map<number, string>, args: unknown[], outcome: Outcome): number {
  const opened = outcome.guests?.[0];
  if (outcome.errno !== 0 || opened === undefined) return outcome.errno;
  const out = args[8] as number;
  const fd = new DataView(guest.bytes().buffer, out, 4).getUint32(0, true);
  paths.set(fd, opened);
  return 0;
}

/** A renamed directory moves this process's open descriptors under it, as on Linux. */
function recordRename(paths: Map<number, string>, outcome: Outcome): number {
  const [from, to] = outcome.guests ?? [];
  if (outcome.errno !== 0 || from === undefined || to === undefined) return outcome.errno;
  for (const [fd, path] of paths) {
    if (path === from || path.startsWith(from + "/")) paths.set(fd, to + path.slice(from.length));
  }
  return 0;
}

/** path_symlink: uvwasi stores no absolute target, so every link is written here, as given,
 * under its parent resolved in the guest namespace. */
function createLink(namespace: GuestNamespace, guest: Memory, paths: Map<number, string>, call: Call, args: unknown[]): number {
  const [targetPtr, targetLen, fd, ptr, len] = args as number[];
  const target = guest.string(targetPtr!, targetLen!);
  const path = guest.string(ptr!, len!);
  if (typeof target === "number") return target;
  if (typeof path === "number") return path;
  const start = paths.get(fd!);
  if (start === undefined) return call(...args);
  const resolved = namespace.resolve(start, path, false);
  if (typeof resolved === "number") return resolved;
  const host = resolved.relative === "." ? resolved.mount.host : `${resolved.mount.host}/${resolved.relative}`;
  try { symlinkSync(target, host); return 0; } catch (error) { return errnoOf(error); }
}
