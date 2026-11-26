(function (internal: BunWasm.Internal & {
  native: {
    /** Opens `path` once and returns `[fd, "dev:ino"]` (full 64-bit identity) or a negative errno. */
    fsWatchResolve(path: string): [number, string] | number;
    /** Registers a watch on an open descriptor from `fsWatchResolve`, or returns a negative errno. */
    fsWatchOpenFd(fd: number, recursive: boolean): number;
    /** Closes a temporary descriptor from `fsWatchResolve`. */
    fsWatchDropFd(fd: number): void;
    /** Whole records, 0 at end of stream, or a negative WASI errno (-6 EAGAIN, -42 ENOBUFS). */
    fsWatchRead(id: number, maxBytes?: number): Uint8Array | number;
    fsWatchClose(id: number): number;
  };
  hasWatchBacklog?: () => boolean;
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
    const MAX_BACKLOG_RECORDS = 128;
    const MAX_BACKLOG_BYTES = 16 * 1024;
    const NOBUFS = -42;

    interface BacklogEntry {
      readonly seq: number;
      readonly payload: readonly WatchRecord[] | number;
      readonly records: number;
      readonly bytes: number;
    }

    interface SharedWatch {
      readonly id: number;
      readonly key: string | undefined;
      readonly subscribers: Set<FSWatcher>;
      readonly backlog: BacklogEntry[];
      backlogRecords: number;
      backlogBytes: number;
      seq: number;
      closed: boolean;
    }

    const sharedById = new Map<number, SharedWatch>();
    const sharedByKey = new Map<string, SharedWatch>();
    let refCount = 0;
    let backlogCount = 0;
    let hubRegistered = false;

    internal.hasWatchBacklog = () => backlogCount > 0;

    // Rethrow from fail so an unhandled watcher error reaches the existing uncaught path.
    const hubWaiter: BunWasm.IoWaiter & { watch: true } = {
      get ref() { return refCount > 0; },
      watch: true,
      permanent: true,
      step: () => pumpWatches(),
      fail(error) { throw error; },
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

    function detachKey(shared: SharedWatch) {
      if (shared.key !== undefined && sharedByKey.get(shared.key) === shared) {
        sharedByKey.delete(shared.key);
      }
    }

    function closeShared(shared: SharedWatch) {
      if (shared.closed) return;
      shared.closed = true;
      if (shared.backlog.length > 0) {
        backlogCount -= shared.backlog.length;
        shared.backlog.length = 0;
        shared.backlogRecords = 0;
        shared.backlogBytes = 0;
      }
      sharedById.delete(shared.id);
      detachKey(shared);
      native.fsWatchClose(shared.id);
      releaseHubIfEmpty();
    }

    function backlogFull(shared: SharedWatch): boolean {
      return shared.backlogRecords >= MAX_BACKLOG_RECORDS || shared.backlogBytes >= MAX_BACKLOG_BYTES;
    }

    /** Drain any events already queued on `shared` into its bounded backlog so a late subscriber
     * starts strictly after them. Passes the remaining record and byte budgets to `fsWatchRead`
     * so excess records stay queued in the provider; returns `"saturated"` when the budget is
     * exhausted, or `"closed"` if `shared` is ending/errored. */
    function captureBoundary(shared: SharedWatch): "joined" | "saturated" | "closed" {
      if (backlogFull(shared)) return "saturated";
      if (typeof native.fsWatchReady === "function" && !native.fsWatchReady()) return "joined";
      while (!shared.closed) {
        const remainingRecords = MAX_BACKLOG_RECORDS - shared.backlogRecords;
        const remainingBytes = MAX_BACKLOG_BYTES - shared.backlogBytes;
        if (remainingRecords <= 0 || remainingBytes < 8) return "saturated";
        // Every encoded watch record is at least 8 bytes, so capping the provider read at
        // min(remainingBytes, remainingRecords * 8) strictly bounds both records and bytes
        // before anything is consumed from the provider.
        const cap = Math.min(remainingBytes, remainingRecords * 8);
        const chunk = native.fsWatchRead(shared.id, cap);
        if (chunk === AGAIN) return "joined";
        if (chunk === NOBUFS) return "saturated";
        const isNumber = typeof chunk === "number";
        const decoded = isNumber ? undefined : decode(chunk);
        const payload = isNumber ? chunk : decoded!;
        const records = isNumber ? 1 : Math.max(1, decoded!.length);
        const bytes = isNumber ? 8 : chunk.byteLength;
        shared.backlog.push({ seq: ++shared.seq, payload, records, bytes });
        shared.backlogRecords += records;
        shared.backlogBytes += bytes;
        backlogCount++;
        internal.markWatchDirty?.();
        if (chunk === 0 || isNumber || decoded!.some(r => r.type === "overflow")) {
          detachKey(shared);
          return "closed";
        }
      }
      return "closed";
    }

    function createShared(id: number, key: string | undefined): SharedWatch {
      const shared: SharedWatch = {
        id, key, subscribers: new Set(), backlog: [], backlogRecords: 0, backlogBytes: 0, seq: 0, closed: false,
      };
      sharedById.set(id, shared);
      if (key !== undefined) sharedByKey.set(key, shared);
      internal.markWatchDirty?.();
      return shared;
    }

    /** Acquire a shared or fresh native watch from a single resolved descriptor so the sharing key
     * always names the exact opened inode (full 64-bit dev:ino) with no stat-to-open TOCTOU race. */
    function acquireShared(path: string, recursive: boolean): { shared: SharedWatch; since: number } {
      const resolved = native.fsWatchResolve(path);
      if (typeof resolved === "number") throw watchError(-resolved, path, true);
      const fd = resolved[0];
      try {
        const identity = resolved[1];
        const key = identity ? `${identity}:${recursive ? 1 : 0}:${path}` : undefined;
        const existing = key !== undefined ? sharedByKey.get(key) : undefined;
        let shareKey = key;
        if (existing && !existing.closed) {
          const boundary = captureBoundary(existing);
          if (boundary === "joined") return { shared: existing, since: existing.seq };
          if (boundary === "saturated") shareKey = undefined;
        }
        const id = native.fsWatchOpenFd(fd, recursive);
        if (id < 0) throw watchError(-id, path, true);
        return { shared: createShared(id, shareKey), since: 0 };
      } finally {
        native.fsWatchDropFd(fd);
      }
    }

    function fanOut(subscribers: readonly FSWatcher[], seq: number, deliver: (watcher: FSWatcher) => void) {
      let hasError = false;
      let firstError: unknown;
      for (const watcher of subscribers) {
        if (watcher._since >= seq) continue;
        try {
          deliver(watcher);
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error;
          } else {
            internal.nextTick(() => { throw error; });
          }
        }
      }
      if (hasError) throw firstError;
    }

    function dispatchPayload(shared: SharedWatch, payload: readonly WatchRecord[] | number, seq: number) {
      const subscribers = Array.from(shared.subscribers);
      if (payload === 0) {
        fanOut(subscribers, seq, watcher => watcher.close());
        return;
      }
      if (typeof payload === "number") {
        fanOut(subscribers, seq, watcher => watcher._deliverErrno(-payload));
        return;
      }
      fanOut(subscribers, seq, watcher => watcher._deliverRecords(payload));
    }

    function drainShared(shared: SharedWatch): boolean {
      let progressed = false;
      while (!shared.closed && shared.backlog.length > 0) {
        const entry = shared.backlog.shift()!;
        backlogCount--;
        shared.backlogRecords -= entry.records;
        shared.backlogBytes -= entry.bytes;
        progressed = true;
        dispatchPayload(shared, entry.payload, entry.seq);
      }
      while (!shared.closed) {
        const chunk = native.fsWatchRead(shared.id);
        if (chunk === AGAIN) break;
        progressed = true;
        const payload = typeof chunk === "number" ? chunk : decode(chunk);
        dispatchPayload(shared, payload, ++shared.seq);
      }
      return progressed;
    }

    function pumpWatches(): boolean | "progress" {
      let progressed = false;
      for (const shared of Array.from(sharedById.values())) {
        if (drainShared(shared)) progressed = true;
      }
      return sharedById.size === 0 ? true : (progressed && "progress");
    }

    class FSWatcher extends EventEmitter {
      readonly _since: number;
      #closed = false;
      #shared: SharedWatch;
      #refed: boolean;
      // Changes, errors and the close an error causes run in the frame current at watch().
      #frame: BunWasm.ResourceFrame;
      #path: string;
      #options: Options;
      #abort = () => this.close();

      constructor(path: string, settings: Options, listener?: Listener) {
        super();
        // Validate everything that can throw before the watch exists.
        if (listener && typeof listener !== "function") throw invalidListener();
        const recursive = Boolean(settings.recursive);
        const { shared, since } = acquireShared(path, recursive);
        this._since = since;
        this.#shared = shared;
        this.#path = path;
        this.#options = settings;
        this.#refed = settings.persistent !== false;
        this.#frame = frames.capture();
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
        this.#frame.run(this.#dispatchPending, this, [payload]);
      }

      #dispatchPending(pending: readonly WatchRecord[] | number): void {
        try {
          if (typeof pending === "number") {
            this.#fail(watchError(pending, this.#path));
            return;
          }
          for (const record of pending) {
            if (this.#closed) return;
            if (record.type === "overflow") {
              this.#fail(watchError(61, this.#path));
              return;
            }
            const encoded = Buffer.from(record.name ?? this.#path.slice(this.#path.lastIndexOf("/") + 1));
            const name = this.#options.encoding === "buffer" ? encoded : encoded.toString(this.#options.encoding);
            this.emit("change", record.type, name);
          }
        } catch (error) {
          this.#fail(error);
        }
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
