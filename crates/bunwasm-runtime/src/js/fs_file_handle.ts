// fs/promises FileHandle over the synchronous WASI natives. Adapted from Bun's
// src/js/node/fs.promises.ts (FileHandle, readableWebStream, pull, pullSync and writer,
// themselves ports of Node 26's lib/internal/fs/promises.js); see
// docs/bun-patches/fs-file-handle-and-mkdtemp.md. Operations run synchronously, so only streams,
// web streams, pull sources and writers hold a reference that defers close().
(function (internal: BunWasm.Internal) {
  "use strict";

  type Bytes = Uint8Array;
  type Options = Record<string, unknown>;
  type Reject = (error: unknown) => void;

  interface BufferStatic {
    allocUnsafe(size: number): Bytes;
    concat(list: readonly Bytes[]): Bytes;
  }

  interface Dependencies {
    Buffer: BufferStatic;
    closeSync(fd: number): void;
    readFileSync(fd: number, options?: unknown): unknown;
    writeFileSync(fd: number, data: unknown, options?: unknown): void;
    appendFileSync(fd: number, data: unknown, options?: unknown): void;
    readSync(fd: number, buffer: unknown, offset?: unknown, length?: unknown, position?: unknown): number;
    readvSync(fd: number, buffers: unknown, position?: unknown): number;
    writeSync(fd: number, data: unknown, offset?: unknown, length?: unknown, position?: unknown): number;
    writevSync(fd: number, buffers: unknown, position?: unknown): number;
    fstatSync(fd: number, options?: unknown): unknown;
    ftruncateSync(fd: number, length?: unknown): void;
    createReadStream(path: undefined, options: Options): unknown;
    createWriteStream(path: undefined, options: Options): unknown;
    later(callback: () => void): void;
  }

  interface PullOptions {
    autoClose: boolean;
    chunkSize: number;
    start: number;
    limit: number;
    signal: AbortSignal | undefined;
  }

  const kIterDefaultChunkSize = 131072;
  const kRef = Symbol("kRef");
  const kUnref = Symbol("kUnref");
  const kCloseSync = Symbol("kCloseSync");
  const kLock = Symbol("kLock");
  const kMaxSafe = Number.MAX_SAFE_INTEGER;
  const EventEmitter = internal.require("events");

  function codeError<T extends Error>(Ctor: new (message: string) => T, code: string, message: string): T & { code: string } {
    return Object.assign(new Ctor(message), { code });
  }

  function invalidState(message: string, Ctor: new (message: string) => Error = Error) {
    return codeError(Ctor, "ERR_INVALID_STATE", `Invalid state: ${message}`);
  }

  // Node's ERR_INVALID_ARG_TYPE names a dotted option a property.
  function invalidType(name: string, expected: string, value: unknown) {
    const kind = name.includes(".") ? "property" : "argument";
    return codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" ${kind} must be ${expected}. Received ${internal.describe(value)}`);
  }

  function outOfRange(name: string, expected: string, value: unknown) {
    return codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be ${expected}. Received ${String(value)}`);
  }

  function validateObject(value: unknown, name: string): asserts value is Options {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidType(name, "of type object", value);
  }

  function validateBoolean(value: unknown, name: string): asserts value is boolean {
    if (typeof value !== "boolean") throw invalidType(name, "of type boolean", value);
  }

  function validateInteger(value: unknown, name: string, min: number): asserts value is number {
    if (typeof value !== "number") throw invalidType(name, "of type number", value);
    if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
    if (value < min || value > kMaxSafe) throw outOfRange(name, `>= ${min} && <= ${kMaxSafe}`, value);
  }

  function validateAbortSignal(value: unknown, name: string): asserts value is AbortSignal | undefined {
    if (value === undefined) return;
    if (value === null || typeof value !== "object" || !("aborted" in value)) throw invalidType(name, "an instance of AbortSignal", value);
  }

  function abortReason(signal: AbortSignal) {
    return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  // Bun reports a closed handle as a SystemError without an errno.
  function badFileDescriptor(syscall: string) {
    return Object.assign(new Error("Bad file descriptor"), { code: "EBADF", name: "SystemError", syscall });
  }

  let encoder: TextEncoder | undefined;
  function toUint8Array(chunk: unknown): Bytes {
    if (typeof chunk === "string") return (encoder ??= new TextEncoder()).encode(chunk);
    if (!(chunk instanceof Uint8Array)) throw invalidType("chunk", "of type string or an instance of Uint8Array", chunk);
    return chunk;
  }

  function convertChunks(chunks: unknown): Bytes[] {
    if (!Array.isArray(chunks)) throw invalidType("chunks", "an instance of Array", chunks);
    return Array.from(chunks as readonly unknown[], toUint8Array);
  }

  function isTransform(value: unknown) {
    return typeof value === "function" || (value !== null && typeof value === "object" && typeof (value as { transform?: unknown }).transform === "function");
  }

  // Node's parsePullArgs: trailing options, transforms before it. Transforms need Node's
  // iterable streams pipeline, which this runtime does not provide yet.
  function pullOptions(args: readonly unknown[]): PullOptions {
    const last = args[args.length - 1];
    const hasOptions = last !== null && typeof last === "object" && !("transform" in last) && !("write" in last);
    const transforms = hasOptions ? args.slice(0, -1) : args;
    transforms.forEach((transform, index) => {
      if (!isTransform(transform)) throw invalidType(`transforms[${index}]`, "an instance of Function or Object with transform()", transform);
    });
    if (transforms.length > 0) {
      throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "FileHandle pull transforms are not supported in bun-wasm");
    }
    const options = (hasOptions ? last : {}) as Options;
    const { autoClose = false, chunkSize = kIterDefaultChunkSize, start = -1, limit = -1, signal } = options;
    validateBoolean(autoClose, "options.autoClose");
    if (start !== -1) validateInteger(start, "options.start", 0);
    if (limit !== -1) validateInteger(limit, "options.limit", 1);
    if (chunkSize !== undefined) validateInteger(chunkSize, "options.chunkSize", 1);
    validateAbortSignal(signal, "options.signal");
    return { autoClose, chunkSize: chunkSize as number, start: start as number, limit: limit as number, signal };
  }

  function later(deps: Dependencies) {
    return new Promise<void>(resolve => deps.later(resolve));
  }

  return function createFileHandles(deps: Dependencies) {
    const handles = new WeakSet<object>();
    type FinalizerState = { fd: number; path: string | undefined; closed: boolean };
    // Adapted from Bun's src/js/node/fs.promises.ts (DEP0137 end-of-life): close a leaked
    // FileHandle's fd on GC and raise ERR_INVALID_STATE on a later turn.
    const finalizers = typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<FinalizerState>((held) => {
        if (held.closed) return;
        held.closed = true;
        try {
          deps.closeSync(held.fd);
        } catch {}
        const suffix = held.path !== undefined ? ` (${held.path})` : "";
        const err = codeError(
          Error,
          "ERR_INVALID_STATE",
          "A FileHandle object was closed during garbage collection. This used to be allowed " +
            "with a deprecation warning but is now considered an error. Please close FileHandle " +
            `objects explicitly. File descriptor: ${held.fd}${suffix}`,
        );
        deps.later(() => {
          throw err;
        });
      })
      : undefined;

    class FileHandle extends EventEmitter {
      #fd: number;
      #refs = 1;
      #locked = false;
      #closing: Promise<void> | undefined;
      #closeResolve: (() => void) | undefined;
      #closeReject: Reject | undefined;
      #finalizerState: FinalizerState;

      constructor(fd: number, path?: string) {
        super();
        this.#fd = fd;
        this.#finalizerState = { fd, path, closed: fd < 0 };
        if (fd >= 0) finalizers?.register(this, this.#finalizerState, this.#finalizerState);
        handles.add(this);
      }

      #disarmFinalizer() {
        if (this.#finalizerState.closed) return;
        this.#finalizerState.closed = true;
        finalizers?.unregister(this.#finalizerState);
      }

      get fd() {
        return this.#fd;
      }

      #open(syscall: string) {
        if (this.#fd === -1) throw badFileDescriptor(syscall);
        return this.#fd;
      }

      #available() {
        if (this.#fd === -1) throw invalidState("The FileHandle is closed");
        if (this.#closing) throw invalidState("The FileHandle is closing");
        if (this.#locked) throw invalidState("The FileHandle is locked");
        return this.#fd;
      }

      async readFile(options?: unknown) {
        return deps.readFileSync(this.#open("readFile"), options);
      }
      async writeFile(data: unknown, options?: unknown) {
        return deps.writeFileSync(this.#open("writeFile"), data, options);
      }
      async appendFile(data: unknown, options?: unknown) {
        return deps.appendFileSync(this.#open("writeFile"), data, options);
      }
      async read(buffer?: Bytes, offset?: unknown, length?: unknown, position?: unknown) {
        const fd = this.#open("read");
        const target = buffer || deps.Buffer.allocUnsafe(16384);
        const bytesRead = deps.readSync(fd, target, offset, length, position);
        return { bytesRead, buffer: target };
      }
      async readv(buffers: unknown, position?: unknown) {
        return { bytesRead: deps.readvSync(this.#open("readv"), buffers, position), buffers };
      }
      async write(data: unknown, offset?: unknown, length?: unknown, position?: unknown) {
        const bytesWritten = deps.writeSync(this.#open("write"), data, offset, length, position);
        return { bytesWritten, buffer: data };
      }
      async writev(buffers: unknown, position?: unknown) {
        return { bytesWritten: deps.writevSync(this.#open("writev"), buffers, position), buffers };
      }
      async stat(options?: unknown) {
        return deps.fstatSync(this.#open("fstat"), options);
      }
      async truncate(length?: unknown) {
        deps.ftruncateSync(this.#open("ftruncate"), length);
      }
      async sync() {
        this.#open("fsync");
      }
      async datasync() {
        this.#open("fdatasync");
      }

      async close() {
        if (this.#fd === -1) return;
        if (this.#closing) return this.#closing;
        if (--this.#refs === 0) {
          const fd = this.#fd;
          this.#fd = -1;
          this.#disarmFinalizer();
          this.#closing = settleClose(fd).finally(() => { this.#closing = undefined; });
        } else {
          this.#closing = new Promise<void>((resolve, reject) => {
            this.#closeResolve = resolve;
            this.#closeReject = reject;
          }).finally(() => {
            this.#closing = undefined;
            this.#closeResolve = undefined;
            this.#closeReject = undefined;
          });
        }
        this.emit("close");
        return this.#closing;
      }

      async [Symbol.asyncDispose]() {
        return this.close();
      }

      [kRef]() {
        this.#refs++;
      }

      // The last reference closes the captured fd and settles a deferred close().
      [kUnref]() {
        if (--this.#refs !== 0) return;
        const fd = this.#fd;
        this.#fd = -1;
        this.#disarmFinalizer();
        (fd === -1 ? Promise.resolve() : settleClose(fd)).then(this.#closeResolve, this.#closeReject);
      }

      // Closes now for pullSync and writer autoClose.
      [kCloseSync]() {
        if (this.#fd === -1) return;
        if (this.#closing) throw invalidState("The FileHandle is closing");
        const fd = this.#fd;
        this.#fd = -1;
        this.#disarmFinalizer();
        deps.closeSync(fd);
        this.emit("close");
      }

      [kLock](locked: boolean) {
        this.#locked = locked;
      }

      createReadStream(options: Options = {}) {
        this.#open("createReadStream");
        return deps.createReadStream(undefined, Object.assign({ highWaterMark: 64 * 1024 }, options, { fd: this }));
      }

      createWriteStream(options: Options = {}) {
        this.#open("createWriteStream");
        return deps.createWriteStream(undefined, Object.assign({ highWaterMark: 64 * 1024 }, options, { fd: this }));
      }

      readableWebStream(options: unknown = {}) {
        this.#available();
        this.#locked = true;
        validateObject(options, "options");
        const { type = "bytes", autoClose = false } = options;
        validateBoolean(autoClose, "options.autoClose");
        if (type !== "bytes") {
          process.emitWarning?.('A non-"bytes" options.type has no effect. A byte-oriented steam is always created.', "ExperimentalWarning");
        }
        return readableWebStream(this, autoClose);
      }

      pull(...args: unknown[]) {
        this.#available();
        const options = pullOptions(args);
        if (options.signal?.aborted) return abortedPull(this, options);
        this.#locked = true;
        return pullSource(this, this.#fd, options);
      }

      pullSync(...args: unknown[]) {
        this.#available();
        const options = pullOptions(args);
        this.#locked = true;
        return pullSyncSource(this, this.#fd, options);
      }

      writer(options: unknown = {}) {
        const fd = this.#available();
        validateObject(options, "options");
        const { autoClose = false, chunkSize = kIterDefaultChunkSize, start = -1, limit = -1 } = options;
        validateBoolean(autoClose, "options.autoClose");
        if (start !== -1) validateInteger(start, "options.start", 0);
        if (limit !== -1) validateInteger(limit, "options.limit", 1);
        if (chunkSize !== undefined) validateInteger(chunkSize, "options.chunkSize", 1);
        this.#locked = true;
        return createWriter(this, fd, autoClose, chunkSize as number, start as number, limit as number);
      }
    }

    function settleClose(fd: number) {
      try {
        deps.closeSync(fd);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve();
    }

    type Handle = FileHandle;

    // --- readableWebStream ----------------------------------------------------

    function readableWebStream(handle: Handle, autoClose: boolean) {
      const { ReadableStream } = internal.require("streams");
      let controllerRef: ReadableByteStreamController | undefined;
      let done = false;

      async function ondone() {
        if (done) return;
        done = true;
        handle.removeListener("close", onFileHandleClose);
        handle[kUnref]();
        if (autoClose) await handle.close();
      }

      // Closing the handle ends the stream, even while a reader waits on a read.
      function onFileHandleClose() {
        if (done) return;
        try { controllerRef?.close(); } catch {}
        try { controllerRef?.byobRequest?.respond(0); } catch {}
        void ondone();
      }

      async function pull(controller: ReadableByteStreamController) {
        const request = controller.byobRequest;
        if (request === null) return;
        const view = request.view as Uint8Array;
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(view, view.byteOffset, view.byteLength));
        } catch (error) {
          if (done) return;
          await ondone();
          throw error;
        }
        if (done) return;
        if (bytesRead === 0) {
          controller.close();
          await ondone();
        }
        controller.byobRequest?.respond(bytesRead);
      }

      const readable = new ReadableStream({
        type: "bytes",
        autoAllocateChunkSize: 16384,
        start(controller: ReadableByteStreamController) { controllerRef = controller; },
        pull,
        async cancel() { await ondone(); },
      });
      handle[kRef]();
      handle.once("close", onFileHandleClose);
      return readable;
    }

    // --- pull and pullSync ------------------------------------------------------

    function abortedPull(handle: Handle, { autoClose, signal }: PullOptions) {
      let done = false;
      async function finish() {
        if (done) return { value: undefined, done: true };
        done = true;
        if (autoClose) await handle.close();
        throw abortReason(signal as AbortSignal);
      }
      async function stop() {
        if (!done && autoClose) await handle.close();
        done = true;
        return { value: undefined, done: true };
      }
      return { __proto__: null, [Symbol.asyncIterator]: () => ({ __proto__: null, next: finish, return: stop }) };
    }

    function readChunk(fd: number, state: { pos: number; remaining: number }, chunkSize: number) {
      const toRead = state.remaining > 0 ? Math.min(chunkSize, state.remaining) : chunkSize;
      const buffer = deps.Buffer.allocUnsafe(toRead);
      const bytesRead = deps.readSync(fd, buffer, 0, toRead, state.pos >= 0 ? state.pos : null) || 0;
      if (bytesRead === 0) return null;
      if (state.pos >= 0) state.pos += bytesRead;
      if (state.remaining > 0) state.remaining -= bytesRead;
      return bytesRead < toRead ? buffer.subarray(0, bytesRead) : buffer;
    }

    function pullSource(handle: Handle, fd: number, options: PullOptions) {
      const state = { pos: options.start, remaining: options.limit };
      const { signal } = options;
      return {
        __proto__: null,
        async *[Symbol.asyncIterator]() {
          if (handle.fd === -1) throw invalidState("The FileHandle is closed");
          handle[kRef]();
          try {
            while (state.remaining !== 0) {
              if (signal?.aborted) throw abortReason(signal);
              await later(deps);
              const chunk = readChunk(fd, state, options.chunkSize);
              if (chunk === null) break;
              yield [chunk];
            }
          } finally {
            handle[kLock](false);
            handle[kUnref]();
            if (options.autoClose) await handle.close();
          }
        },
      };
    }

    function pullSyncSource(handle: Handle, fd: number, options: PullOptions) {
      const state = { pos: options.start, remaining: options.limit };
      return {
        __proto__: null,
        [Symbol.iterator]() {
          if (handle.fd === -1) throw invalidState("The FileHandle is closed");
          handle[kRef]();
          let done = false;
          let cleanedUp = false;
          function cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            handle[kLock](false);
            handle[kUnref]();
            if (options.autoClose) handle[kCloseSync]();
          }
          function finish() {
            done = true;
            cleanup();
            return { value: undefined, done: true };
          }
          function next() {
            if (done || state.remaining === 0) return finish();
            let chunk;
            try {
              chunk = readChunk(fd, state, options.chunkSize);
            } catch (error) {
              finish();
              throw error;
            }
            if (chunk === null) return finish();
            return { value: [chunk], done: false };
          }
          return { __proto__: null, next, return: () => (done ? { value: undefined, done: true } : finish()) };
        },
      };
    }

    // --- writer -----------------------------------------------------------------

    function createWriter(handle: Handle, fd: number, autoClose: boolean, syncWriteThreshold: number, start: number, limit: number) {
      let pos = start;
      let bytesRemaining = limit;
      let totalBytesWritten = 0;
      let closed = false;
      let closing = false;
      let pendingEndPromise: Promise<number> | null = null;
      let error: unknown = null;
      // Writes run on a later turn, as Bun's run on its threadpool; end() and fail()
      // defer the teardown past every write still in flight.
      let asyncPending = 0;
      let deferredTeardown: (() => void) | null = null;
      // Take the reference on the first write so an unused writer cannot hang close().
      let refAcquired = false;

      function acquireRef() {
        if (refAcquired) return;
        refAcquired = true;
        handle[kRef]();
      }

      function releaseRef() {
        if (!refAcquired) return;
        refAcquired = false;
        handle[kUnref]();
      }

      function runDeferredTeardown() {
        const teardown = deferredTeardown;
        deferredTeardown = null;
        teardown?.();
      }

      function writeSyncAll(buffer: Bytes, offset: number, length: number, position: number) {
        let retries = 0;
        while (length > 0) {
          const bytesWritten = deps.writeSync(fd, buffer, offset, length, position >= 0 ? position : null) || 0;
          retries = bytesWritten === 0 ? retries + 1 : 0;
          if (retries > 5) throw codeError(Error, "ERR_OPERATION_FAILED", "Operation failed: write failed after retries");
          totalBytesWritten += bytesWritten;
          offset += bytesWritten;
          length -= bytesWritten;
          if (position >= 0) position += bytesWritten;
        }
      }

      async function writeAll(buffer: Bytes, position: number, signal: AbortSignal | undefined) {
        asyncPending++;
        try {
          await later(deps);
          writeSyncAll(buffer, 0, buffer.byteLength, position);
          signal?.throwIfAborted();
        } catch (failure) {
          // A failed write may have reached the disk partly; the writer is poisoned like fail().
          if (!closed && !error) error = failure;
          throw failure;
        } finally {
          if (--asyncPending === 0) runDeferredTeardown();
        }
      }

      async function cleanup() {
        if (closed) return;
        closed = true;
        handle[kLock](false);
        if (asyncPending === 0) {
          releaseRef();
          if (autoClose) await handle.close();
          return;
        }
        return new Promise<void>((resolve, reject) => {
          deferredTeardown = () => {
            releaseRef();
            if (autoClose) handle.close().then(resolve, reject);
            else resolve();
          };
        });
      }

      function rejected(): Promise<never> | undefined {
        if (error) return Promise.reject(error);
        if (closed) return Promise.reject(invalidState("The writer is closed", TypeError));
        if (handle.fd === -1) return Promise.reject(invalidState("The FileHandle is closed"));
        return undefined;
      }

      function writeOptions(options: unknown) {
        validateObject(options, "options");
        const { signal } = options;
        validateAbortSignal(signal, "options.signal");
        return signal;
      }

      // Like Bun, argument errors throw; state and limit errors reject.
      function queue(name: string, bytes: () => Bytes, options: unknown) {
        const refusal = rejected();
        if (refusal) return refusal;
        const signal = writeOptions(options);
        if (signal?.aborted) return Promise.reject(signal.reason);
        const buffer = bytes();
        const length = buffer.byteLength;
        if (bytesRemaining >= 0 && length > bytesRemaining) return Promise.reject(outOfRange(name, `<= ${bytesRemaining} bytes`, length));
        if (bytesRemaining > 0) bytesRemaining -= length;
        const position = pos;
        if (pos >= 0) pos += length;
        acquireRef();
        return writeAll(buffer, position, signal);
      }

      function writeNow(bytes: () => Bytes) {
        if (error || closed || asyncPending) return false;
        if (handle.fd === -1) throw invalidState("The FileHandle is closed");
        const buffer = bytes();
        const length = buffer.byteLength;
        if (length > syncWriteThreshold) return false;
        if (length === 0) return true;
        if (bytesRemaining >= 0 && length > bytesRemaining) return false;
        const position = pos;
        acquireRef();
        let bytesWritten;
        try {
          bytesWritten = deps.writeSync(fd, buffer, 0, length, position >= 0 ? position : null) || 0;
        } catch {
          return false;
        }
        totalBytesWritten += bytesWritten;
        // A partial write is on disk: finish it or throw.
        if (bytesWritten !== length) writeSyncAll(buffer, bytesWritten, length - bytesWritten, position >= 0 ? position + bytesWritten : -1);
        if (position >= 0) pos = position + length;
        if (bytesRemaining > 0) bytesRemaining -= length;
        return true;
      }

      function teardownNow() {
        releaseRef();
        if (autoClose) handle[kCloseSync]();
      }

      return {
        __proto__: null,
        write(chunk: unknown, options: unknown = {}) {
          return queue("write", () => toUint8Array(chunk), options);
        },
        writev(chunks: unknown, options: unknown = {}) {
          return queue("writev", () => deps.Buffer.concat(convertChunks(chunks)), options);
        },
        writeSync(chunk: unknown) {
          return writeNow(() => toUint8Array(chunk));
        },
        writevSync(chunks: unknown) {
          return writeNow(() => deps.Buffer.concat(convertChunks(chunks)));
        },
        end(options: unknown = {}) {
          if (error) return Promise.reject(error);
          if (closed) return Promise.resolve(totalBytesWritten);
          if (closing) return pendingEndPromise as Promise<number>;
          const signal = writeOptions(options);
          if (signal?.aborted) return Promise.reject(signal.reason);
          closing = true;
          pendingEndPromise = cleanup().then(() => totalBytesWritten);
          return pendingEndPromise;
        },
        endSync() {
          if (error) return -1;
          if (closed) return totalBytesWritten;
          if (asyncPending) return -1;
          closed = true;
          handle[kLock](false);
          teardownNow();
          return totalBytesWritten;
        },
        fail(reason?: unknown) {
          if (closed || error) return;
          error = reason ?? invalidState("Failed");
          closed = true;
          handle[kLock](false);
          if (asyncPending) deferredTeardown = teardownNow;
          else teardownNow();
        },
        [Symbol.asyncDispose](this: { fail(): void }) {
          if (closing) return pendingEndPromise ?? Promise.resolve();
          if (!closed && !error) this.fail();
          return Promise.resolve();
        },
        [Symbol.dispose](this: { fail(): void }) {
          this.fail();
        },
      };
    }

    // A file stream opened over a FileHandle holds a reference and closes with it.
    function linkStream(value: unknown, onClose: () => void) {
      if (value === null || typeof value !== "object" || !handles.has(value)) return undefined;
      const handle = value as Handle;
      handle[kRef]();
      handle.on("close", onClose);
      return {
        fd: handle.fd,
        close() {
          handle[kUnref]();
          return handle.close();
        },
      };
    }

    const isFileHandle = (value: unknown): value is Handle => value !== null && typeof value === "object" && handles.has(value);

    return { FileHandle, isFileHandle, linkStream };
  };
})
