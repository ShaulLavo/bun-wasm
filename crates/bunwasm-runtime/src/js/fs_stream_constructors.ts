(function () {
  "use strict";

  const kFs = Symbol("kFs");
  const kIsPerformingIO = Symbol("kIsPerformingIO");
  const kIoDone = Symbol("kIoDone");

  type Flags = string | number;
  interface CustomFs {
    open?: (path: unknown, flags: Flags, mode: number, callback: (error: unknown, fd?: number) => void) => void;
    write?: (fd: number | null, data: Uint8Array, offset: number, length: number, position: number | undefined, callback: (error: unknown, bytesWritten?: number, buffer?: Uint8Array) => void) => void;
    writev?: (fd: number | null, chunks: Uint8Array[], position: number | undefined, callback: (error: unknown, bytesWritten?: number, buffers?: Uint8Array[]) => void) => void;
    close?: (fd: number, callback: (error?: unknown) => void) => void;
    fsync?: (fd: number, callback: (error?: unknown) => void) => void;
  }

  type Options = {
    fd?: number | object;
    flags?: Flags;
    mode?: number;
    autoClose?: boolean;
    flush?: boolean;
    fs?: CustomFs | null;
    start?: number;
    end?: number;
    encoding?: string;
    defaultEncoding?: string;
    highWaterMark?: number;
    decodeStrings?: boolean;
  } & Record<string, unknown>;

  interface BaseFileStream {
    fd: number | null;
    path: unknown;
    flags: Flags;
    mode: number;
    autoClose: boolean;
    flush?: boolean;
    pending: boolean;
    pos: number | undefined;
    start: number | undefined;
    [kFs]?: CustomFs;
    [kIsPerformingIO]?: boolean;
    emit(event: string | symbol, ...args: unknown[]): unknown;
    once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    _construct(callback: (error?: unknown) => void): void;
    _destroy(error: unknown, callback: (error?: unknown) => void): void;
  }

  interface ReadFileStream extends BaseFileStream {
    end: number;
    bytesRead: number;
    push(chunk: Uint8Array | null): unknown;
    destroy(error?: unknown): unknown;
    destroyed: boolean;
    _read(size: number): void;
    close(callback?: (error?: unknown) => void): void;
  }

  interface WriteFileStream extends BaseFileStream {
    bytesWritten: number;
    writableFinished: boolean;
    destroyed: boolean;
    destroy(error?: unknown): unknown;
    end(): unknown;
    _write: ((chunk: Uint8Array, encoding: string, callback: (error?: unknown) => void) => void) | null;
    _writev?: ((entries: readonly { chunk: Uint8Array }[], callback: (error?: unknown) => void) => void) | null;
    close(callback?: () => void): void;
  }

  interface ReadStreamConstructor {
    (this: ReadFileStream | undefined, path: unknown, options?: string | Options | null): ReadFileStream;
    new(path: unknown, options?: string | Options | null): ReadFileStream;
    prototype: ReadFileStream;
  }

  interface WriteStreamConstructor {
    (this: WriteFileStream | undefined, path: unknown, options?: string | Options | null): WriteFileStream;
    new(path: unknown, options?: string | Options | null): WriteFileStream;
    prototype: WriteFileStream;
  }

  interface StreamConstructor {
    prototype: object;
    call(receiver: BaseFileStream, options: object): void;
  }

  interface StreamModule {
    Readable: StreamConstructor;
    Writable: StreamConstructor;
    finished(stream: object, callback: (error?: unknown) => void): void;
  }

  interface Dependencies {
    read(fd: number | null, length: number, position: number): Uint8Array;
    asBuffer(bytes: Uint8Array): Uint8Array;
    concatBuffers(buffers: readonly Uint8Array[]): Uint8Array;
    readPieceSize: number;
    isRegularReadFd(fd: number | null): boolean;
    openSync(path: unknown, flags: Flags, mode?: number): number;
    closeSync(fd: number): void;
    writeSync(fd: number | null, bytes: Uint8Array, offset: number, length: number, position: number | undefined): number;
    fsyncSync(fd: number): void;
    toPath(path: unknown): string;
    validateFd(fd: unknown): void;
    readRange(name: string, value: unknown): Error;
    invalidArg(name: string, expected: string, value: unknown): Error;
    isEncoding(encoding: string): boolean;
    inspect(value: unknown): string;
    loadStreams(): StreamModule;
    later(callback: () => void): void;
    isHandle(value: unknown): boolean;
    /** A FileHandle passed as options.fd: the stream holds a reference and closes with the handle. */
    linkHandle(value: unknown, onClose: () => void): HandleLink | undefined;
  }

  interface HandleLink {
    fd: number;
    close(): Promise<void>;
  }

  return function createFileStreams(deps: Dependencies) {
    const { read, asBuffer, openSync, closeSync, writeSync, fsyncSync, toPath, validateFd, readRange, invalidArg } = deps;
    let fileStreams: StreamModule | undefined;

    function initializeFileStreams() {
      if (fileStreams) return fileStreams;
      fileStreams = deps.loadStreams();
      Object.setPrototypeOf(ReadStream.prototype, fileStreams.Readable.prototype);
      Object.setPrototypeOf(WriteStream.prototype, fileStreams.Writable.prototype);
      return fileStreams;
    }

    // Node's assertEncoding for stream options; "buffer" and a missing encoding are fine.
    function checkedEncoding(options: Options): Options {
      const { encoding } = options;
      if (encoding == null || encoding === "buffer" || deps.isEncoding(encoding)) return options;
      throw Object.assign(new TypeError(`The argument 'encoding' is invalid encoding. Received ${deps.inspect(encoding)}`), { code: "ERR_INVALID_ARG_VALUE" });
    }

    function fileStreamOptions(options: string | Options | null | undefined): Options {
      if (typeof options === "string") return checkedEncoding({ encoding: options });
      // Node's getOptions: a function in the options slot means no options.
      if (options == null || typeof options === "function") return {};
      if (typeof options !== "object") throw invalidArg("options", "an object or string", options);
      return checkedEncoding(options);
    }

    function fileStreamPosition(name: string, value: number) {
      if (!Number.isSafeInteger(value) || value < 0) throw readRange(name, value);
      return value;
    }

    const handleLinks = new WeakMap<BaseFileStream, HandleLink>();

    interface StreamSetup {
      fd: Options["fd"];
      isHandle: boolean;
      hasFd: boolean;
      path: unknown;
      flags: Flags;
      mode: number;
      autoClose: boolean;
      pos: number | undefined;
    }

    function prepareStreamSetup(path: unknown, options: Options, flags: Flags): StreamSetup {
      const fd = options.fd;
      const hasFd = fd !== undefined;
      const isHandle = hasFd && typeof fd === "object" && deps.isHandle(fd);
      if (hasFd && !isHandle) validateFd(fd);
      const streamPath = hasFd ? path : toPath(path);
      const pos = options.start === undefined ? undefined : fileStreamPosition("start", options.start);
      return {
        fd,
        isHandle,
        hasFd,
        path: streamPath,
        flags: options.flags === undefined ? flags : options.flags,
        mode: options.mode === undefined ? 0o666 : options.mode,
        autoClose: options.autoClose !== false,
        pos,
      };
    }

    function attachStreamSetup(stream: BaseFileStream & { close(): void }, setup: StreamSetup) {
      if (!setup.hasFd) {
        stream.fd = null;
      } else if (setup.isHandle) {
        const link = deps.linkHandle(setup.fd, () => stream.close());
        if (!link) {
          validateFd(setup.fd);
          stream.fd = setup.fd as number;
        } else {
          handleLinks.set(stream, link);
          stream.fd = link.fd;
        }
      } else {
        stream.fd = setup.fd as number;
      }
      stream.path = setup.path;
      stream.flags = setup.flags;
      stream.mode = setup.mode;
      stream.autoClose = setup.autoClose;
      stream.pending = stream.fd === null;
      stream.pos = setup.pos;
    }

    const ReadStream = function (this: ReadFileStream | undefined, path: unknown, options?: string | Options | null): ReadFileStream {
      if (!(this instanceof ReadStream)) return new ReadStream(path, options);
      const streams = initializeFileStreams();
      const config = fileStreamOptions(options);
      const setup = prepareStreamSetup(path, config, "r");
      const end = config.end === undefined || config.end === Infinity ? Infinity : fileStreamPosition("end", config.end);
      if (end < (setup.pos || 0)) throw readRange("start", setup.pos);
      attachStreamSetup(this, setup);
      this.start = config.start;
      this.end = end;
      this.bytesRead = 0;
      streams.Readable.call(this, { ...config, highWaterMark: config.highWaterMark ?? 65536, autoDestroy: this.autoClose });
      return this;
    } as ReadStreamConstructor;

    function validateCustomWriteFs(setup: StreamSetup, customFs: CustomFs, flush: boolean) {
      if (!setup.hasFd && typeof customFs.open !== "function") throw invalidArg("options.fs.open", "of type function", customFs.open);
      if (customFs.write != null && typeof customFs.write !== "function") throw invalidArg("options.fs.write", "of type function", customFs.write);
      if (customFs.writev != null && typeof customFs.writev !== "function") throw invalidArg("options.fs.writev", "of type function", customFs.writev);
      if (setup.autoClose && typeof customFs.close !== "function") throw invalidArg("options.fs.close", "of type function", customFs.close);
      if (flush && typeof customFs.fsync !== "function") throw invalidArg("options.fs.fsync", "of type function", customFs.fsync);
      if (customFs.write == null && customFs.writev == null) throw invalidArg("options.fs.write", "of type function", customFs.write);
    }

    const WriteStream = function (this: WriteFileStream | undefined, path: unknown, options?: string | Options | null): WriteFileStream {
      if (!(this instanceof WriteStream)) return new WriteStream(path, options);
      const streams = initializeFileStreams();
      const config = fileStreamOptions(options);
      const setup = prepareStreamSetup(path, config, "w");
      if (config.flush !== undefined && typeof config.flush !== "boolean") throw invalidArg("options.flush", "of type boolean", config.flush);
      const flush = Boolean(config.flush);
      const customFs = config.fs !== undefined && config.fs !== null ? config.fs : undefined;
      if (customFs !== undefined) {
        if (typeof customFs !== "object") throw invalidArg("options.fs", "of type object", customFs);
        if (setup.isHandle) {
          throw Object.assign(new Error("The FileHandle with fs method is not implemented"), { code: "ERR_METHOD_NOT_IMPLEMENTED" });
        }
        validateCustomWriteFs(setup, customFs, flush);
      }
      attachStreamSetup(this, setup);
      this.flush = flush;
      this.start = config.start;
      this.bytesWritten = 0;
      this[kIsPerformingIO] = false;
      if (customFs !== undefined) {
        this[kFs] = customFs;
        if (customFs.write == null) this._write = null;
        if (customFs.writev == null) this._writev = null;
      } else {
        this._writev = undefined;
      }
      streams.Writable.call(this, {
        ...config,
        decodeStrings: true,
        defaultEncoding: config.encoding || config.defaultEncoding,
        autoDestroy: this.autoClose,
      });
      return this;
    } as WriteStreamConstructor;

    function constructFileStream(this: BaseFileStream, callback: (error?: unknown) => void) {
      if (this.fd !== null) { callback(); return; }
      const customFs = this[kFs];
      if (customFs?.open) {
        customFs.open(this.path, this.flags, this.mode, (error, fd) => {
          this.pending = false;
          if (error) { callback(error); return; }
          this.fd = fd ?? null;
          this.emit("open", this.fd);
          this.emit("ready");
          callback();
        });
        return;
      }
      try { this.fd = openSync(this.path, this.flags, this.mode); }
      catch (error) { this.pending = false; callback(error); return; }
      this.pending = false;
      this.emit("open", this.fd);
      this.emit("ready");
      callback();
    }

    function finishCustomClose(customFs: CustomFs, fd: number, error: unknown, callback: (error?: unknown) => void) {
      if (!customFs.close) { callback(error); return; }
      customFs.close(fd, (closeError) => callback(closeError || error));
    }

    function closeCustomStreamHandle(customFs: CustomFs, fd: number | null, flush: boolean | undefined, error: unknown, callback: (error?: unknown) => void) {
      if (fd === null) { callback(error); return; }
      if (!flush || !customFs.fsync) { finishCustomClose(customFs, fd, error, callback); return; }
      customFs.fsync(fd, (syncError) => finishCustomClose(customFs, fd, error || syncError, callback));
    }

    function flushDefaultDescriptor(fd: number, error: unknown): unknown {
      try { fsyncSync(fd); }
      catch (syncError) { return error || syncError; }
      return error;
    }

    function closeStreamHandle(stream: BaseFileStream, error: unknown, callback: (error?: unknown) => void) {
      const fd = stream.fd;
      stream.fd = null;
      stream.pending = false;
      const customFs = stream[kFs];
      if (customFs) { closeCustomStreamHandle(customFs, fd, stream.flush, error, callback); return; }
      let finalError = error;
      if (stream.flush && fd !== null) finalError = flushDefaultDescriptor(fd, finalError);
      const link = handleLinks.get(stream);
      if (link) {
        handleLinks.delete(stream);
        link.close().then(() => callback(finalError), (closeError: unknown) => callback(finalError || closeError));
        return;
      }
      if (fd === null) { callback(finalError); return; }
      try { closeSync(fd); }
      catch (closeError) { callback(finalError || closeError); return; }
      callback(finalError);
    }

    function destroyFileStream(this: BaseFileStream, error: unknown, callback: (error?: unknown) => void) {
      if (this[kIsPerformingIO]) {
        this.once(kIoDone, (ioError: unknown) => closeStreamHandle(this, error || ioError, callback));
        return;
      }
      closeStreamHandle(this, error, callback);
    }

    ReadStream.prototype._construct = constructFileStream;
    WriteStream.prototype._construct = constructFileStream;
    ReadStream.prototype._destroy = destroyFileStream;
    WriteStream.prototype._destroy = destroyFileStream;

    ReadStream.prototype._read = function (this: ReadFileStream, size: number) {
      let length = Math.min(Math.max(size, 1), this.end - (this.pos === undefined ? this.bytesRead : this.pos) + 1);
      if (length <= 0) { this.push(null); return; }
      let chunk;
      try {
        validateFd(this.fd);
        if (length > deps.readPieceSize && deps.isRegularReadFd(this.fd)) length = deps.readPieceSize;
        chunk = asBuffer(read(this.fd, length, this.pos ?? -1));
      }
      catch (error) { this.destroy(error); return; }
      const count = chunk.length;
      this.bytesRead += count;
      if (this.pos !== undefined) this.pos += count;
      // Deliver like fs.read's callback, on a later turn. A synchronous push(null) right
      // after a short read lands while the previous 'readable' is still being emitted,
      // which drops the end-of-file 'readable' Node and Bun emit.
      const result = count === 0 ? null : chunk;
      deps.later(() => { if (!this.destroyed) this.push(result); });
    };

    function writeFileStreamStep(stream: WriteFileStream, chunk: Uint8Array, offset: number) {
      const count = writeSync(stream.fd, chunk, offset, chunk.length - offset, stream.pos);
      if (count === 0) throw Object.assign(new Error("write made no progress"), { code: "EIO", syscall: "write" });
      stream.bytesWritten += count;
      if (stream.pos !== undefined) stream.pos += count;
      return count;
    }

    function writeFileStreamChunk(stream: WriteFileStream, chunk: Uint8Array) {
      let offset = 0;
      while (offset < chunk.length) offset += writeFileStreamStep(stream, chunk, offset);
    }

    function streamDestroyed(operation: string) {
      return Object.assign(new Error(`Cannot call ${operation} after a stream was destroyed`), { code: "ERR_STREAM_DESTROYED" });
    }

    function writeAllCustom(
      stream: WriteFileStream,
      customFs: CustomFs,
      data: Uint8Array,
      size: number,
      pos: number | undefined,
      callback: (error?: unknown) => void,
      retries: number,
    ) {
      customFs.write!(stream.fd, data, 0, size, pos, (error, written = 0, buffer) => {
        if ((error as { code?: string } | null)?.code === "EAGAIN") {
          error = null;
          written = 0;
        }
        if (stream.destroyed || error) { callback(error || streamDestroyed("write")); return; }
        stream.bytesWritten += written;
        const nextRetries = written ? 0 : retries + 1;
        const remaining = size - written;
        const nextPos = pos === undefined ? undefined : pos + written;
        if (nextRetries > 5) callback(new Error("write failed"));
        else if (remaining > 0) writeAllCustom(stream, customFs, (buffer ?? data).subarray(written), remaining, nextPos, callback, nextRetries);
        else callback();
      });
    }

    function writevAllCustom(
      stream: WriteFileStream,
      customFs: CustomFs,
      chunks: Uint8Array[],
      size: number,
      pos: number | undefined,
      callback: (error?: unknown) => void,
      retries: number,
    ) {
      customFs.writev!(stream.fd, chunks, pos, (error, written = 0, buffers) => {
        if ((error as { code?: string } | null)?.code === "EAGAIN") {
          error = null;
          written = 0;
        }
        if (stream.destroyed || error) { callback(error || streamDestroyed("writev")); return; }
        stream.bytesWritten += written;
        const nextRetries = written ? 0 : retries + 1;
        const remaining = size - written;
        const nextPos = pos === undefined ? undefined : pos + written;
        if (nextRetries > 5) callback(new Error("writev failed"));
        else if (remaining > 0) writevAllCustom(stream, customFs, [deps.concatBuffers(buffers ?? chunks).subarray(written)], remaining, nextPos, callback, nextRetries);
        else callback();
      });
    }

    WriteStream.prototype._write = function (this: WriteFileStream, chunk: Uint8Array, _encoding: string, callback: (error?: unknown) => void) {
      const customFs = this[kFs];
      if (customFs) {
        const pos = this.pos;
        if (this.pos !== undefined) this.pos += chunk.length;
        this[kIsPerformingIO] = true;
        writeAllCustom(this, customFs, chunk, chunk.length, pos, (error) => {
          this[kIsPerformingIO] = false;
          callback(error);
          if (this.destroyed) this.emit(kIoDone, error);
        }, 0);
        return;
      }
      try { writeFileStreamChunk(this, chunk); }
      catch (error) { callback(error); return; }
      callback();
    };

    WriteStream.prototype._writev = function (this: WriteFileStream, entries: readonly { chunk: Uint8Array }[], callback: (error?: unknown) => void) {
      const customFs = this[kFs];
      if (!customFs?.writev) { callback(); return; }
      const chunks = new Array<Uint8Array>(entries.length);
      let size = 0;
      for (let i = 0; i < entries.length; i++) {
        const chunk = entries[i]!.chunk;
        chunks[i] = chunk;
        size += chunk.length;
      }
      const pos = this.pos;
      if (this.pos !== undefined) this.pos += size;
      this[kIsPerformingIO] = true;
      writevAllCustom(this, customFs, chunks, size, pos, (error) => {
        this[kIsPerformingIO] = false;
        callback(error);
        if (this.destroyed) this.emit(kIoDone, error);
      }, 0);
    };

    ReadStream.prototype.close = function (this: ReadFileStream, callback?: (error?: unknown) => void) {
      if (typeof callback === "function") initializeFileStreams().finished(this, callback);
      this.destroy();
    };

    WriteStream.prototype.close = function (this: WriteFileStream, callback?: () => void) {
      if (callback) this.once("close", callback);
      if (this.writableFinished) { this.destroy(); return; }
      if (!this.autoClose) this.once("finish", () => this.destroy());
      this.end();
    };

    function createReadStream(path: unknown, options?: string | Options | null) {
      return new ReadStream(path, options);
    }

    function createWriteStream(path: unknown, options?: string | Options | null) {
      return new WriteStream(path, options);
    }

    return { ReadStream, WriteStream, createReadStream, createWriteStream, initializeFileStreams };
  };
})
