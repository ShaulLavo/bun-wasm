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
    toPath(path: unknown): string;
    validateFd(fd: unknown): void;
    readRange(name: string, value: unknown): Error;
    invalidArg(name: string, expected: string, value: unknown): Error;
    isEncoding(encoding: string): boolean;
    inspect(value: unknown): string;
    loadStreams(): StreamModule;
    later(callback: () => void): void;
    /** A FileHandle passed as options.fd: the stream holds a reference and closes with the handle. */
    linkHandle(value: unknown, onClose: () => void): HandleLink | undefined;
  }

  interface HandleLink {
    fd: number;
    close(): Promise<void>;
  }

  return function createFileStreams(deps: Dependencies) {
    const { read, asBuffer, openSync, closeSync, writeSync, toPath, validateFd, readRange, invalidArg } = deps;
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

    function streamFd(stream: BaseFileStream, fd: Options["fd"], onHandleClose: () => void) {
      if (fd === undefined) return null;
      const link = typeof fd === "object" ? deps.linkHandle(fd, onHandleClose) : undefined;
      if (!link) {
        validateFd(fd);
        return fd as number;
      }
      handleLinks.set(stream, link);
      return link.fd;
    }

    function initializeFileStream(stream: BaseFileStream & { close(): void }, path: unknown, options: Options, flags: Flags) {
      stream.fd = streamFd(stream, options.fd, () => stream.close());
      stream.path = stream.fd === null ? toPath(path) : path;
      stream.flags = options.flags === undefined ? flags : options.flags;
      stream.mode = options.mode === undefined ? 0o666 : options.mode;
      stream.autoClose = options.autoClose !== false;
      stream.pending = stream.fd === null;
      stream.pos = options.start === undefined ? undefined : fileStreamPosition("start", options.start);
    }

    const ReadStream = function (this: ReadFileStream | undefined, path: unknown, options?: string | Options | null): ReadFileStream {
      if (!(this instanceof ReadStream)) return new ReadStream(path, options);
      const streams = initializeFileStreams();
      const config = fileStreamOptions(options);
      initializeFileStream(this, path, config, "r");
      this.start = config.start;
      this.end = config.end === undefined || config.end === Infinity ? Infinity : fileStreamPosition("end", config.end);
      if (this.end < (this.pos || 0)) throw readRange("start", this.pos);
      this.bytesRead = 0;
      streams.Readable.call(this, { ...config, highWaterMark: config.highWaterMark ?? 65536, autoDestroy: this.autoClose });
      return this;
    } as ReadStreamConstructor;

    function validateCustomWriteFs(stream: WriteFileStream, customFs: CustomFs, flush: boolean) {
      if (stream.fd === null && typeof customFs.open !== "function") throw invalidArg("options.fs.open", "of type function", customFs.open);
      if (customFs.write !== undefined && typeof customFs.write !== "function") throw invalidArg("options.fs.write", "of type function", customFs.write);
      if (customFs.writev !== undefined && typeof customFs.writev !== "function") throw invalidArg("options.fs.writev", "of type function", customFs.writev);
      if (stream.autoClose && typeof customFs.close !== "function") throw invalidArg("options.fs.close", "of type function", customFs.close);
      if (flush && typeof customFs.fsync !== "function") throw invalidArg("options.fs.fsync", "of type function", customFs.fsync);
      if (!customFs.write && !customFs.writev) throw invalidArg("options.fs.write", "of type function", customFs.write);
      if (!customFs.write) stream._write = null;
      if (!customFs.writev) stream._writev = null;
    }

    const WriteStream = function (this: WriteFileStream | undefined, path: unknown, options?: string | Options | null): WriteFileStream {
      if (!(this instanceof WriteStream)) return new WriteStream(path, options);
      const streams = initializeFileStreams();
      const config = fileStreamOptions(options);
      initializeFileStream(this, path, config, "w");
      if (config.flush !== undefined && typeof config.flush !== "boolean") throw invalidArg("options.flush", "of type boolean", config.flush);
      this.flush = Boolean(config.flush);
      this.start = config.start;
      this.bytesWritten = 0;
      this[kIsPerformingIO] = false;
      if (config.fs !== undefined && config.fs !== null) {
        if (typeof config.fs !== "object") throw invalidArg("options.fs", "of type object", config.fs);
        if (handleLinks.has(this)) {
          throw Object.assign(new Error("The FileHandle with fs method is not implemented"), { code: "ERR_METHOD_NOT_IMPLEMENTED" });
        }
        this[kFs] = config.fs;
        validateCustomWriteFs(this, config.fs, this.flush);
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

    function closeStreamHandle(stream: BaseFileStream, error: unknown, callback: (error?: unknown) => void) {
      const fd = stream.fd;
      stream.fd = null;
      stream.pending = false;
      const customFs = stream[kFs];
      if (customFs) {
        if (fd === null) { callback(error); return; }
        const closeFd = (syncError?: unknown) => {
          const err = error || syncError;
          if (!customFs.close) { callback(err); return; }
          customFs.close(fd, (closeError) => callback(closeError || err));
        };
        if (stream.flush && customFs.fsync) customFs.fsync(fd, closeFd);
        else closeFd();
        return;
      }
      const link = handleLinks.get(stream);
      if (link) {
        handleLinks.delete(stream);
        link.close().then(() => callback(error), (closeError: unknown) => callback(error || closeError));
        return;
      }
      if (fd === null) { callback(error); return; }
      try { closeSync(fd); }
      catch (closeError) { callback(error || closeError); return; }
      callback(error);
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
