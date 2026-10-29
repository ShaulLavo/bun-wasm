(function (internal: BunWasm.Internal & {
  native: {
    fsWatchOpen(path: string, recursive: boolean): number;
    procRead(fd: number, capacity?: number): Uint8Array | number;
    procClose(fd: number): number;
  };
  nextTick(callback: () => void): void;
}) {
  "use strict";
  interface FileSystem {
    statSync(path: string): unknown;
    toPath(path: unknown): string;
    absolute(path: string): string;
  }
  type WatchRecord = { type: "change" | "rename"; name: Uint8Array | null } | { type: "overflow" };
  interface Options {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: string;
    signal?: AbortSignal;
  }
  type Listener = (...args: unknown[]) => void;
  const EventEmitter = internal.require("events");
  const { Buffer } = internal.require("buffer");

  const native = internal.native;
  const AGAIN = -6;
  const READ_CAPACITY = 65536;
  const NULL_NAME = 0xffffffff;
  const RECORD_TYPES = [undefined, "change", "rename", "overflow"] as const;
  // WASI errno -> Node code and errno, as for the synchronous filesystem natives.
  const ERRORS: Record<number, [string, number | undefined]> = {
    2: ["EACCES", -13], 6: ["EAGAIN", -11], 8: ["EBADF", -9], 11: ["ECANCELED", -125], 28: ["EINVAL", -22],
    29: ["EIO", -5], 44: ["ENOENT", -2], 48: ["ENOMEM", -12], 52: ["ENOSYS", -38], 54: ["ENOTDIR", -20],
    58: ["ENOTSUP", -95], 61: ["EOVERFLOW", -75], 63: ["EPERM", -1], 76: ["ENOTCAPABLE", undefined],
  };

  function watchError(wasiErrno: number, path: string) {
    const [code, errno] = ERRORS[wasiErrno] ?? [`E${wasiErrno}`, undefined];
    return Object.assign(new Error(`${code}: watch '${path}'`), { code, errno, syscall: "watch", path, filename: path });
  }

  // Packed runtime_proc watch records: u8 type, 3 reserved bytes, u32 LE name length
  // (0xffffffff for the watched root), then the UTF-8 relative name.
  function decode(bytes: Uint8Array): WatchRecord[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const records: WatchRecord[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const type = RECORD_TYPES[bytes[offset]];
      const length = view.getUint32(offset + 4, true);
      offset += 8;
      if (type === undefined) throw new Error(`unknown filesystem watch record ${bytes[offset - 8]}`);
      if (type === "overflow") { records.push({ type }); continue; }
      const name = length === NULL_NAME ? null : bytes.subarray(offset, offset + length);
      if (name) offset += length;
      records.push({ type, name });
    }
    return records;
  }

  function readable(fd: number) {
    const subscription = new Uint8Array(16);
    new DataView(subscription.buffer).setUint32(4, fd, true);
    return subscription;
  }

  function filenameEncoding(value: unknown): string | undefined {
    if (value == null || value === "") return undefined;
    if (typeof value === "string" && (value === "buffer" || Buffer.isEncoding(value))) return value;
    throw Object.assign(new TypeError("Unknown filename encoding"), { code: "ERR_INVALID_ARG_VALUE" });
  }

  function options(value: unknown): Options {
    if (value == null) return {};
    if (typeof value === "string") return { encoding: filenameEncoding(value) };
    if (typeof value !== "object") throw new TypeError('The "options" argument must be an object or string');
    const result: Options = {};
    if ("recursive" in value && value.recursive !== undefined) {
      if (typeof value.recursive !== "boolean") throw new TypeError('The "options.recursive" argument must be a boolean');
      result.recursive = value.recursive;
    }
    if ("persistent" in value && value.persistent !== undefined) {
      if (typeof value.persistent !== "boolean") throw new TypeError('The "options.persistent" argument must be a boolean');
      result.persistent = value.persistent;
    }
    if ("encoding" in value) result.encoding = filenameEncoding(value.encoding);
    if ("signal" in value && value.signal !== undefined) {
      if (!(value.signal instanceof AbortSignal)) throw new TypeError('The "options.signal" argument must be an AbortSignal');
      result.signal = value.signal;
    }
    return result;
  }

  return function createWatch(fs: FileSystem) {
    class FSWatcher extends EventEmitter {
      #closed = false;
      #fd: number;
      #waiter: BunWasm.IoWaiter & { late: true };
      #path: string;
      #options: Options;
      #abort = () => this.close();

      constructor(path: string, settings: Options, listener?: Listener) {
        super();
        fs.statSync(path);
        const fd = native.fsWatchOpen(path, Boolean(settings.recursive));
        if (fd < 0) throw watchError(-fd, path);
        this.#fd = fd;
        this.#path = path;
        this.#options = settings;
        if (listener) this.on("change", listener);
        const subscription = readable(fd);
        internal.require("net");
        this.#waiter = internal.addIoWaiter({
          ref: settings.persistent !== false,
          late: true,
          step: () => this.#step(),
          fail: (error: unknown) => this.#fail(error),
          subscriptions: () => subscription,
        });
        if (settings.signal?.aborted) internal.nextTick(this.#abort);
        else settings.signal?.addEventListener("abort", this.#abort, { once: true });
      }

      #step(): boolean | "progress" {
        let progressed = false;
        while (!this.#closed) {
          const chunk = native.procRead(this.#fd, READ_CAPACITY);
          if (chunk === AGAIN) return progressed && "progress";
          if (chunk === 0) { this.close(); return true; }
          if (typeof chunk === "number") { this.#fail(watchError(-chunk, this.#path)); return true; }
          progressed = true;
          for (const record of decode(chunk)) this.#dispatch(record);
        }
        return true;
      }

      #dispatch(record: WatchRecord) {
        if (this.#closed) return;
        if (record.type === "overflow") { this.#fail(watchError(61, this.#path)); return; }
        const encoded = Buffer.from(record.name ?? this.#path.slice(this.#path.lastIndexOf("/") + 1));
        this.emit("change", record.type, this.#options.encoding === "buffer" ? encoded : encoded.toString(this.#options.encoding));
      }

      #fail(error: unknown) {
        this.close();
        this.emit("error", error);
      }

      close() {
        if (this.#closed) return;
        this.#closed = true;
        internal.removeIoWaiter(this.#waiter);
        native.procClose(this.#fd);
        this.#options.signal?.removeEventListener("abort", this.#abort);
        internal.nextTick(() => this.emit("close"));
      }
      ref() { if (!this.#closed) this.#waiter.ref = true; return this; }
      unref() { if (!this.#closed) this.#waiter.ref = false; return this; }
    }

    function watch(path: unknown, value?: unknown, listener?: Listener) {
      if (typeof value === "function") {
        listener = value as Listener;
        value = undefined;
      }
      const settings = options(value);
      return new FSWatcher(fs.absolute(fs.toPath(path)), settings, listener);
    }
    return { watch, FSWatcher };
  };
})
