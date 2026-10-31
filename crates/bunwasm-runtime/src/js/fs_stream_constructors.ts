(function () {
  "use strict";

  type Flags = string | number;
  type Options = {
    fd?: number;
    flags?: Flags;
    mode?: number;
    autoClose?: boolean;
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
    pending: boolean;
    pos: number | undefined;
    start: number | undefined;
    emit(event: string, ...args: unknown[]): unknown;
    _construct(callback: (error?: unknown) => void): void;
    _destroy(error: unknown, callback: (error?: unknown) => void): void;
  }

  interface ReadFileStream extends BaseFileStream {
    end: number;
    bytesRead: number;
    once(event: string, listener: () => void): unknown;
    push(chunk: Uint8Array | null): unknown;
    destroy(error?: unknown): unknown;
    _read(size: number): void;
    close(callback?: () => void): void;
  }

  interface WriteFileStream extends BaseFileStream {
    bytesWritten: number;
    writableFinished: boolean;
    once(event: string, listener: () => void): unknown;
    destroy(error?: unknown): unknown;
    end(): unknown;
    _write(chunk: Uint8Array, encoding: string, callback: (error?: unknown) => void): void;
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
  }

  interface Dependencies {
    Buffer: { allocUnsafe(length: number): Uint8Array };
    openSync(path: unknown, flags: Flags, mode?: number): number;
    closeSync(fd: number): void;
    readSync(fd: number | null, buffer: Uint8Array, offset: number, length: number, position: number | undefined): number;
    writeSync(fd: number | null, bytes: Uint8Array, offset: number, length: number, position: number | undefined): number;
    toPath(path: unknown): string;
    validateFd(fd: unknown): void;
    readRange(name: string, value: unknown): Error;
    invalidArg(name: string, expected: string, value: unknown): Error;
    loadStreams(): StreamModule;
  }

  return function createFileStreams(deps: Dependencies) {
    const { Buffer, openSync, closeSync, readSync, writeSync, toPath, validateFd, readRange, invalidArg } = deps;
    let fileStreams: StreamModule | undefined;

    function initializeFileStreams() {
      if (fileStreams) return fileStreams;
      fileStreams = deps.loadStreams();
      Object.setPrototypeOf(ReadStream.prototype, fileStreams.Readable.prototype);
      Object.setPrototypeOf(WriteStream.prototype, fileStreams.Writable.prototype);
      return fileStreams;
    }

    function fileStreamOptions(options: string | Options | null | undefined): Options {
      if (typeof options === "string") return { encoding: options };
      if (options == null) return {};
      if (typeof options !== "object") throw invalidArg("options", "an object or string", options);
      return options;
    }

    function fileStreamPosition(name: string, value: number) {
      if (!Number.isSafeInteger(value) || value < 0) throw readRange(name, value);
      return value;
    }

    function initializeFileStream(stream: BaseFileStream, path: unknown, options: Options, flags: Flags) {
      stream.fd = options.fd === undefined ? null : options.fd;
      if (stream.fd !== null) validateFd(stream.fd);
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

    const WriteStream = function (this: WriteFileStream | undefined, path: unknown, options?: string | Options | null): WriteFileStream {
      if (!(this instanceof WriteStream)) return new WriteStream(path, options);
      const streams = initializeFileStreams();
      const config = fileStreamOptions(options);
      initializeFileStream(this, path, config, "w");
      this.start = config.start;
      this.bytesWritten = 0;
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
      try { this.fd = openSync(this.path, this.flags, this.mode); }
      catch (error) { this.pending = false; callback(error); return; }
      this.pending = false;
      this.emit("open", this.fd);
      this.emit("ready");
      callback();
    }

    function destroyFileStream(this: BaseFileStream, error: unknown, callback: (error?: unknown) => void) {
      const fd = this.fd;
      this.fd = null;
      this.pending = false;
      if (fd === null) { callback(error); return; }
      try { closeSync(fd); }
      catch (closeError) { callback(error || closeError); return; }
      callback(error);
    }

    ReadStream.prototype._construct = constructFileStream;
    WriteStream.prototype._construct = constructFileStream;
    ReadStream.prototype._destroy = destroyFileStream;
    WriteStream.prototype._destroy = destroyFileStream;

    ReadStream.prototype._read = function (this: ReadFileStream, size: number) {
      const length = Math.min(Math.max(size, 1), this.end - (this.pos === undefined ? this.bytesRead : this.pos) + 1);
      if (length <= 0) { this.push(null); return; }
      const chunk = Buffer.allocUnsafe(length);
      let count;
      try { count = readSync(this.fd, chunk, 0, length, this.pos); }
      catch (error) { this.destroy(error); return; }
      this.bytesRead += count;
      if (this.pos !== undefined) this.pos += count;
      this.push(count === 0 ? null : chunk.subarray(0, count));
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

    WriteStream.prototype._write = function (this: WriteFileStream, chunk: Uint8Array, _encoding: string, callback: (error?: unknown) => void) {
      try { writeFileStreamChunk(this, chunk); }
      catch (error) { callback(error); return; }
      callback();
    };

    ReadStream.prototype.close = function (this: ReadFileStream, callback?: () => void) {
      if (callback) this.once("close", callback);
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
