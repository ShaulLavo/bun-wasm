// Filesystem helpers for writev view snapshots, recursive readdir traversal,
// async stack attachment, and Bun's 4-argument fs.symlink callback overload.
// See docs/bun-patches/fs-buffers-readdir-callbacks.md.
(function () {
  "use strict";

  type InvalidArgFn = (name: string, expected: string, value: unknown) => Error;
  type ReaddirEntry = [name: string, kind: string];
  type NativeReaddir = (abs: string) => ReaddirEntry[];
  type CreateDirent = (name: string, kind: string, parentPath: string) => unknown;

  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get as (this: ArrayBufferView) => ArrayBufferLike;
  const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get as (this: ArrayBufferView) => number;
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get as (this: ArrayBufferView) => number;
  const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get as (this: DataView) => ArrayBufferLike;
  const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get as (this: DataView) => number;
  const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get as (this: DataView) => number;
  const arrayBufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached")?.get as ((this: ArrayBuffer) => boolean) | undefined;

  function isDetachedBuffer(buffer: ArrayBufferLike): boolean {
    if (!(buffer instanceof ArrayBuffer)) return false;
    return arrayBufferDetached ? arrayBufferDetached.call(buffer) : false;
  }

  // Convert a validated ArrayBufferView using intrinsic prototype getters so shadowed own
  // properties cannot spoof byteOffset/byteLength/buffer, and detached buffers (including
  // detached DataViews) map to an empty Uint8Array without throwing.
  function viewToUint8(view: ArrayBufferView): Uint8Array {
    try {
      const buffer = typedArrayBuffer.call(view);
      if (isDetachedBuffer(buffer)) return new Uint8Array(0);
      const byteLength = typedArrayByteLength.call(view);
      if (byteLength === 0) return new Uint8Array(0);
      return new Uint8Array(buffer, typedArrayByteOffset.call(view), byteLength);
    } catch {
      const dataView = view as DataView;
      const buffer = dataViewBuffer.call(dataView);
      if (isDetachedBuffer(buffer)) return new Uint8Array(0);
      const byteLength = dataViewByteLength.call(dataView);
      if (byteLength === 0) return new Uint8Array(0);
      return new Uint8Array(buffer, dataViewByteOffset.call(dataView), byteLength);
    }
  }

  function snapshotWritev(buffers: unknown, invalidArg: InvalidArgFn): ArrayBufferView[] {
    if (!Array.isArray(buffers)) throw invalidArg("buffers", "an array", buffers);
    const count = buffers.length;
    const items: ArrayBufferView[] = [];
    for (let i = 0; i < count; i++) {
      const buffer = buffers[i];
      if (!ArrayBuffer.isView(buffer)) throw invalidArg("buffers", "an array of ArrayBufferView instances", buffers);
      items.push(buffer);
    }
    return items;
  }

  function writevViews(items: readonly ArrayBufferView[]): Uint8Array[] {
    return items.map(viewToUint8);
  }

  function normalizeRecursiveRoot(given: string): string {
    let root = given;
    while (root.length > 1 && root.endsWith("/")) root = root.slice(0, -1);
    while (root.startsWith("./")) root = root.slice(2);
    while (root.length > 1 && root.endsWith("/")) root = root.slice(0, -1);
    return root === "." ? "" : root;
  }

  function joinDisplayPath(base: string, part: string): string {
    if (!base) return part;
    if (!part) return base;
    return base === "/" ? `/${part}` : `${base}/${part}`;
  }

  function joinAbsolutePath(base: string, name: string): string {
    return base === "/" ? `/${name}` : `${base}/${name}`;
  }

  function rewriteReaddirError(err: unknown, displayPath: string, syscall: "scandir" | "open"): unknown {
    if (err && typeof err === "object") {
      const rec = err as { path?: unknown; message?: unknown; syscall?: unknown };
      const oldPath = typeof rec.path === "string" ? rec.path : undefined;
      const oldSyscall = typeof rec.syscall === "string" ? rec.syscall : undefined;
      if (typeof rec.message === "string") {
        let message = rec.message;
        if (oldSyscall && oldSyscall !== syscall) {
          message = message.replace(`, ${oldSyscall} `, `, ${syscall} `);
        }
        if (oldPath && oldPath !== displayPath) {
          message = message.replace(`'${oldPath}'`, `'${displayPath}'`);
        }
        rec.message = message;
      }
      rec.syscall = syscall;
      rec.path = displayPath;
    }
    return err;
  }

  function readdirTree(
    abs: string,
    given: string,
    recursive: boolean,
    withFileTypes: boolean,
    isAsync: boolean,
    nativeReaddir: NativeReaddir,
    createDirent: CreateDirent,
  ): unknown[] {
    const out: unknown[] = [];
    const recursiveRoot = recursive ? normalizeRecursiveRoot(given) : given;

    function collectSymlinkDir(dirAbs: string, rel: string): void {
      try {
        collectDir(dirAbs, rel);
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      }
    }

    function collectDir(dirAbs: string, prefix: string): void {
      let entries: ReaddirEntry[];
      try {
        entries = nativeReaddir(dirAbs);
      } catch (err) {
        if (prefix === "") throw rewriteReaddirError(err, given, "scandir");
        if (isAsync) throw rewriteReaddirError(err, joinDisplayPath(recursiveRoot, prefix), "open");
        throw rewriteReaddirError(err, given, "scandir");
      }
      const parentPath = recursive ? joinDisplayPath(recursiveRoot, prefix) : given;
      for (const [name, kind] of entries) {
        const rel = prefix ? `${prefix}/${name}` : name;
        out.push(withFileTypes ? createDirent(name, kind, parentPath) : rel);
        if (!recursive) continue;
        if (kind === "dir") collectDir(joinAbsolutePath(dirAbs, name), rel);
        else if (kind === "symlink") collectSymlinkDir(joinAbsolutePath(dirAbs, name), rel);
      }
    }

    collectDir(abs, "");
    return out;
  }

  // Append captured async frames onto a rejected error without mutating frozen/non-writable
  // errors or discarding frames already present on error.stack.
  function attachAsyncStack(error: unknown, capturedStack?: string): void {
    if (!error || typeof error !== "object") return;
    let current: unknown;
    try {
      current = (error as { stack?: unknown }).stack;
    } catch {
      return;
    }
    if (typeof current !== "string") return;
    const captured = capturedStack ?? new Error().stack;
    if (typeof captured !== "string") return;
    const idx = captured.indexOf("\n    at async ");
    if (idx === -1) return;
    const own = Object.getOwnPropertyDescriptor(error, "stack");
    if (own) {
      if ("value" in own && !own.writable) return;
      if (!("value" in own) && typeof own.set !== "function") return;
    } else if (!Object.isExtensible(error)) {
      return;
    }
    try {
      (error as { stack: string }).stack = current + captured.slice(idx);
    } catch {
      // Preserve the original thrown error if stack assignment fails.
    }
  }

  // Adapted from Bun's src/js/node/fs.ts symlink overload: 3-argument calls validate the
  // callback; 4-argument calls with a non-callable callback fall through to promises.symlink;
  // callable callbacks receive a single (err) argument (undefined on success).
  function runSymlinkCallback(
    target: unknown,
    path: unknown,
    type: unknown,
    callback: unknown,
    deps: {
      symlinkSync(target: unknown, path: unknown, type: unknown): void;
      symlinkPromise(target: unknown, path: unknown, type: unknown): Promise<void>;
      later(fn: () => void): void;
      pinArguments(dataIndex: number, args: unknown[]): (() => void) | null;
      argumentErrors: Set<string>;
      invalidArg: InvalidArgFn;
    },
  ): void {
    let cb = callback;
    let linkType = type;
    if (cb === undefined) {
      cb = type;
      linkType = undefined;
      if (typeof cb !== "function") throw deps.invalidArg("cb", "of type function", cb);
    } else if (typeof cb !== "function") {
      deps.symlinkPromise(target, path, linkType).then(cb as never, cb as never);
      return;
    }
    const fn = cb as (err?: unknown) => void;
    const release = deps.pinArguments(1, [target, path, linkType]);
    let error: unknown = undefined;
    try {
      deps.symlinkSync(target, path, linkType);
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (typeof code === "string" && deps.argumentErrors.has(code)) {
        if (release !== null) release();
        throw err;
      }
      error = err;
    }
    deps.later(() => {
      if (release !== null) release();
      fn(error);
    });
  }

  return { snapshotWritev, writevViews, readdirTree, attachAsyncStack, runSymlinkCallback };
})
