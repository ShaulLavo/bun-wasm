(function (internal: BunWasm.Internal & {
  native: {
    /** A process-local watch id, or a negative WASI errno (runtime_fs.watch_open). */
    fsWatchOpen(path: string, recursive: boolean): number;
    /** Whole records, 0 at end of stream, or a negative WASI errno (-6 when nothing is pending). */
    fsWatchRead(id: number): Uint8Array | number;
    /** Optional O(1) ready-only drain: [id, bytes | 0 | -errno], null on EAGAIN, undefined if unsupported. */
    fsWatchNext?(): [number, Uint8Array | number] | null | undefined;
    fsWatchClose(id: number): number;
  };
  nextTick(callback: () => void): void;
}) {
  "use strict";
  type StatsRecord = Record<string, unknown>;
  interface FileSystem {
    statSync(path: string, options?: { bigint: boolean; throwIfNoEntry: false }): unknown;
    makeStats(raw: StatsRecord, bigint: boolean): StatsRecord;
    toPath(path: unknown): string;
    absolute(path: string): string;
  }
  interface PollOptions { bigint: boolean; persistent: boolean; interval: number }
  // The guest's setInterval returns Node's Timeout; the runtime types only know the web number.
  interface Timer { ref(): unknown; unref(): unknown }
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
  const frames = internal.require("resource_frame");

  const native = internal.native;
  const AGAIN = -6;
  const NO_SPACE = 6;
  const NULL_NAME = 0xffffffff;
  const RECORD_TYPES = [undefined, "change", "rename", "overflow"] as const;
  // WASI errno -> Node code and errno, as for the synchronous filesystem natives.
  const ERRORS: Record<number, [string, number | undefined]> = {
    2: ["EACCES", -13], 6: ["EAGAIN", -11], 8: ["EBADF", -9], 11: ["ECANCELED", -125], 28: ["EINVAL", -22],
    29: ["EIO", -5], 44: ["ENOENT", -2], 48: ["ENOMEM", -12], 52: ["ENOSYS", -38], 54: ["ENOTDIR", -20],
    58: ["ENOTSUP", -95], 61: ["EOVERFLOW", -75], 63: ["EPERM", -1], 76: ["ENOTCAPABLE", undefined],
  };

  function watchError(wasiErrno: number, path: string, open = false) {
    // The runtime refuses a registration over its watch bounds with EAGAIN; Node reports
    // an exhausted inotify watch limit as ENOSPC.
    const [code, errno] = open && wasiErrno === NO_SPACE ? ["ENOSPC", -28] : ERRORS[wasiErrno] ?? [`E${wasiErrno}`, undefined];
    return Object.assign(new Error(`${code}: watch '${path}'`), { code, errno, syscall: "watch", path, filename: path });
  }

  // runtime_fs.watch_read records: u8 type, 3 zero bytes, u32 LE name length (0xffffffff for
  // the watched root and overflow), then the UTF-8 relative name, zero-padded to 4 bytes.
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
      if (name) offset += (length + 3) & ~3;
      records.push({ type, name });
    }
    return records;
  }

  function invalidListener() {
    return Object.assign(new TypeError('The "listener" argument must be of type function'), { code: "ERR_INVALID_ARG_TYPE" });
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

  function shareKey(path: string, recursive: boolean, stat: unknown): string | undefined {
    if (stat === null || typeof stat !== "object") return undefined;
    const record = stat as StatsRecord;
    const ino = record.ino;
    if ((typeof ino !== "number" && typeof ino !== "bigint") || ino === 0 || ino === 0n) return undefined;
    const mode = record.mode;
    if (typeof mode === "number") {
      const isDir = typeof record.isDirectory === "function" ? Boolean((record.isDirectory as () => unknown)()) : false;
      const required = isDir ? 0o500 : 0o400;
      if ((mode & required) !== required) return undefined;
    }
    const dev = typeof record.dev === "number" || typeof record.dev === "bigint" ? record.dev : 0;
    return `${dev}:${ino}:${recursive ? 1 : 0}:${path}`;
  }

  // fs.watchFile polls stat (docs/bun-patches/fs-watch-file.md). Like libuv's uv_fs_poll, a
  // poll reports a change of any compared field or of existence. A missing file reads as
  // all-zero stats and, when missing at start, reports one change with both stats zero.
  const DEFAULT_POLL_INTERVAL = 5007;
  const MAX_TIMER_WAIT = 2 ** 31 - 1;
  const POLL_COMPARED = ["dev", "ino", "mode", "uid", "gid", "size", "mtimeMs", "ctimeMs", "birthtimeMs"];
  const ZERO_STAT_FIELDS = ["dev", "ino", "mode", "nlink", "uid", "gid", "rdev", "size", "blksize", "blocks"]
    .concat(["atime", "mtime", "ctime", "birthtime"].flatMap(name => [`${name}Ms`, `${name}Ns`]));

  function pollOptions(value: unknown): PollOptions {
    if (value == null) return { bigint: false, persistent: true, interval: DEFAULT_POLL_INTERVAL };
    if (typeof value !== "object") throw Object.assign(new TypeError('The "options" argument must be of type object'), { code: "ERR_INVALID_ARG_TYPE" });
    const given = value as Partial<Record<keyof PollOptions, unknown>>;
    const interval = given.interval === undefined ? DEFAULT_POLL_INTERVAL : given.interval;
    if (typeof interval !== "number") throw Object.assign(new TypeError('The "interval" argument must be of type number'), { code: "ERR_INVALID_ARG_TYPE" });
    // Bun accepts any number; a negative or NaN interval polls without waiting.
    return { bigint: Boolean(given.bigint), persistent: given.persistent !== false, interval: Math.max(0, interval) || 0 };
  }

  return function createWatch(fs: FileSystem) {
    interface SharedWatch {
      readonly id: number;
      readonly key: string | undefined;
      readonly subscribers: Set<FSWatcher>;
      closed: boolean;
    }

    const sharedById = new Map<number, SharedWatch>();
    const sharedByKey = new Map<string, SharedWatch>();
    let refCount = 0;
    let hubRegistered = false;

    const hubWaiter: BunWasm.IoWaiter & { watch: true } = {
      get ref() { return refCount > 0; },
      watch: true,
      permanent: true,
      step: () => pumpWatches(),
      fail: () => {},
    };

    function ensureHub() {
      if (hubRegistered) return;
      internal.require("net");
      internal.addIoWaiter(hubWaiter);
      hubRegistered = true;
    }

    function releaseHubIfEmpty() {
      if (!hubRegistered || sharedById.size > 0) return;
      hubRegistered = false;
      internal.removeIoWaiter(hubWaiter);
    }

    function closeShared(shared: SharedWatch) {
      if (shared.closed) return;
      shared.closed = true;
      sharedById.delete(shared.id);
      if (shared.key !== undefined && sharedByKey.get(shared.key) === shared) {
        sharedByKey.delete(shared.key);
      }
      native.fsWatchClose(shared.id);
      releaseHubIfEmpty();
    }

    function dispatchChunk(shared: SharedWatch, chunk: Uint8Array | number) {
      const subscribers = Array.from(shared.subscribers);
      if (chunk === 0) {
        for (const watcher of subscribers) watcher.close();
        return;
      }
      if (typeof chunk === "number") {
        for (const watcher of subscribers) watcher._deliverErrno(-chunk);
        return;
      }
      const records = decode(chunk);
      for (const watcher of subscribers) watcher._deliverRecords(records);
    }

    function pumpWatches(): boolean | "progress" {
      let progressed = false;
      if (typeof native.fsWatchNext === "function") {
        let unsupported = false;
        while (sharedById.size > 0) {
          const next = native.fsWatchNext();
          if (next === undefined) {
            unsupported = true;
            break;
          }
          if (next === null) break;
          progressed = true;
          const [id, chunk] = next;
          const shared = sharedById.get(id);
          if (!shared) {
            native.fsWatchClose(id);
            continue;
          }
          dispatchChunk(shared, chunk);
        }
        if (!unsupported) {
          return sharedById.size === 0 ? true : (progressed && "progress");
        }
      }
      for (const shared of Array.from(sharedById.values())) {
        while (!shared.closed) {
          const chunk = native.fsWatchRead(shared.id);
          if (chunk === AGAIN) break;
          progressed = true;
          dispatchChunk(shared, chunk);
        }
      }
      return sharedById.size === 0 ? true : (progressed && "progress");
    }

    class FSWatcher extends EventEmitter {
      #closed = false;
      #shared: SharedWatch;
      #refed: boolean;
      // Changes, errors and the close an error causes run in the frame current at watch().
      #frame: BunWasm.ResourceFrame;
      #bound: BunWasm.IoWaiter;
      #pending: readonly WatchRecord[] | number | undefined;
      #path: string;
      #options: Options;
      #abort = () => this.close();

      constructor(path: string, settings: Options, listener?: Listener) {
        super();
        // Validate everything that can throw before the watch exists.
        if (listener && typeof listener !== "function") throw invalidListener();
        const stat = fs.statSync(path);
        const recursive = Boolean(settings.recursive);
        const key = shareKey(path, recursive, stat);
        let shared = key !== undefined ? sharedByKey.get(key) : undefined;
        if (!shared || shared.closed) {
          const id = native.fsWatchOpen(path, recursive);
          if (id < 0) throw watchError(-id, path, true);
          shared = { id, key, subscribers: new Set(), closed: false };
          sharedById.set(id, shared);
          if (key !== undefined) sharedByKey.set(key, shared);
        }
        this.#shared = shared;
        this.#path = path;
        this.#options = settings;
        this.#refed = settings.persistent !== false;
        this.#frame = frames.capture();
        this.#bound = this.#frame.bind({
          ref: false,
          step: () => this.#dispatchPending(),
          fail: (error: unknown) => this.#fail(error),
        });
        shared.subscribers.add(this);
        if (this.#refed) refCount++;
        try {
          if (listener) this.on("change", listener);
          ensureHub();
          if (settings.signal?.aborted) internal.nextTick(this.#abort);
          else settings.signal?.addEventListener("abort", this.#abort, { once: true });
        } catch (error) {
          // No watcher reaches the caller, so nothing else could release the watch.
          this.#release();
          throw error;
        }
      }

      _deliverRecords(records: readonly WatchRecord[]) {
        this.#deliver(records);
      }

      _deliverErrno(wasiErrno: number) {
        this.#deliver(wasiErrno);
      }

      #deliver(payload: readonly WatchRecord[] | number) {
        if (this.#closed) return;
        this.#pending = payload;
        try {
          this.#bound.step();
        } catch (error) {
          this.#bound.fail?.(error);
        } finally {
          this.#pending = undefined;
        }
      }

      #dispatchPending(): boolean {
        const pending = this.#pending;
        if (pending === undefined) return false;
        if (typeof pending === "number") {
          this.#fail(watchError(pending, this.#path));
          return true;
        }
        for (const record of pending) {
          if (this.#closed) return true;
          if (record.type === "overflow") {
            this.#fail(watchError(61, this.#path));
            return true;
          }
          const encoded = Buffer.from(record.name ?? this.#path.slice(this.#path.lastIndexOf("/") + 1));
          this.emit("change", record.type, this.#options.encoding === "buffer" ? encoded : encoded.toString(this.#options.encoding));
        }
        return false;
      }

      #fail(error: unknown) {
        this.close();
        this.emit("error", error);
      }

      #release() {
        this.#closed = true;
        try {
          if (this.#refed) {
            this.#refed = false;
            refCount--;
          }
          this.#shared.subscribers.delete(this);
          if (this.#shared.subscribers.size === 0) closeShared(this.#shared);
          this.#options.signal?.removeEventListener("abort", this.#abort);
        } finally {
          this.#frame.release();
        }
      }

      close() {
        if (this.#closed) return;
        this.#release();
        internal.nextTick(() => this.emit("close"));
      }
      ref() {
        if (!this.#closed && !this.#refed) {
          this.#refed = true;
          refCount++;
        }
        return this;
      }
      unref() {
        if (!this.#closed && this.#refed) {
          this.#refed = false;
          refCount--;
        }
        return this;
      }
    }

    function watch(path: unknown, value?: unknown, listener?: Listener) {
      if (typeof value === "function") {
        listener = value as Listener;
        value = undefined;
      }
      const settings = options(value);
      return new FSWatcher(fs.absolute(fs.toPath(path)), settings, listener);
    }

    const statWatchers = new Map<string, StatWatcher>();

    class StatWatcher extends EventEmitter {
      #timer: Timer | undefined;
      #active = true;
      #refed: boolean;
      #path: string;
      #interval: number;
      #bigint: boolean;
      #previous: StatsRecord = {};

      constructor(path: string, settings: PollOptions) {
        super();
        this.#path = path;
        this.#interval = settings.interval;
        this.#refed = settings.persistent;
        this.#bigint = settings.bigint;
        const found = this.#read();
        this.#previous = found ?? this.#missing();
        this.#wait(this.#interval);
        if (found) return;
        const missing = this.#previous;
        internal.nextTick(() => {
          if (this.#active && this.#previous === missing) this.emit("change", missing, missing);
        });
      }

      // Any failed stat (ENOENT, or ENOTDIR when a parent became a file) reads as missing, as in libuv.
      #read(): StatsRecord | undefined {
        try {
          return fs.statSync(this.#path, { bigint: this.#bigint, throwIfNoEntry: false }) as StatsRecord | undefined;
        } catch {
          return undefined;
        }
      }

      #missing(): StatsRecord {
        return fs.makeStats(Object.fromEntries(ZERO_STAT_FIELDS.map(key => [key, 0])), this.#bigint);
      }

      // JavaScript timers turn waits above 2^31 - 1 ms into 1 ms, so a long interval waits in steps.
      #wait(remaining: number) {
        const step = Math.min(remaining, MAX_TIMER_WAIT);
        this.#timer = setTimeout(() => this.#elapsed(remaining - step), step) as unknown as Timer;
        if (!this.#refed) this.#timer.unref();
      }

      #elapsed(remaining: number) {
        this.#timer = undefined;
        if (!this.#active) return;
        if (remaining > 0) return this.#wait(remaining);
        // A listener may throw to an uncaughtException handler; the next change still arrives.
        try {
          this.#poll();
        } finally {
          if (this.#active && this.#timer === undefined) this.#wait(this.#interval);
        }
      }

      #poll() {
        const current = this.#read() ?? this.#missing();
        const previous = this.#previous;
        if (POLL_COMPARED.every(key => previous[key] === current[key])) return;
        this.#previous = current;
        this.emit("change", current, previous);
      }

      stop() {
        if (!this.#active) return;
        this.#active = false;
        clearTimeout(this.#timer as unknown as number);
        this.#timer = undefined;
        internal.nextTick(() => this.emit("stop"));
      }

      // Public start() does nothing in Bun and Node; a stopped watcher stays stopped.
      start() {}
      ref() { this.#refed = true; this.#timer?.ref(); return this; }
      unref() { this.#refed = false; this.#timer?.unref(); return this; }
    }

    function watchFile(filename: unknown, value?: unknown, listener?: unknown) {
      if (typeof value === "function") {
        listener = value;
        value = undefined;
      }
      if (typeof listener !== "function") throw invalidListener();
      const settings = pollOptions(value);
      const path = fs.absolute(fs.toPath(filename));
      let watcher = statWatchers.get(path);
      if (watcher === undefined) {
        watcher = new StatWatcher(path, settings);
        statWatchers.set(path, watcher);
      }
      watcher.on("change", listener as Listener);
      return watcher;
    }

    function unwatchFile(filename: unknown, listener?: unknown) {
      const path = fs.absolute(fs.toPath(filename));
      const watcher = statWatchers.get(path);
      if (watcher === undefined) return;
      if (typeof listener === "function") watcher.removeListener("change", listener as Listener);
      else watcher.removeAllListeners("change");
      if (watcher.listenerCount("change") > 0) return;
      watcher.stop();
      statWatchers.delete(path);
    }

    return { watch, FSWatcher, watchFile, unwatchFile };
  };
})
