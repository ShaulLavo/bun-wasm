(function (internal: BunWasm.Internal & {
  timers: {
    setInterval(callback: () => void, delay: number): { ref(): void; unref(): void };
    clearInterval(timer: { ref(): void; unref(): void }): void;
  };
  nextTick(callback: () => void): void;
}) {
  "use strict";
  interface Stat {
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  interface FileSystem {
    statSync(path: string): Stat;
    lstatSync(path: string): Stat;
    readdirSync(path: string): string[];
    toPath(path: unknown): string;
    absolute(path: string): string;
  }
  interface Options {
    persistent?: boolean;
    recursive?: boolean;
    encoding?: string;
    signal?: AbortSignal;
  }
  type Listener = (...args: unknown[]) => void;
  const EventEmitter = internal.require("events");
  const { Buffer } = internal.require("buffer");

  function missing(error: unknown) {
    return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
  }

  function options(value: unknown): Options {
    if (value == null) return {};
    if (typeof value === "string") return { encoding: value };
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
    if ("encoding" in value && value.encoding !== undefined) {
      if (typeof value.encoding !== "string" || value.encoding !== "buffer" && !Buffer.isEncoding(value.encoding)) throw new TypeError("Unknown filename encoding");
      result.encoding = value.encoding;
    }
    if ("signal" in value && value.signal !== undefined) {
      if (!(value.signal instanceof AbortSignal)) throw new TypeError('The "options.signal" argument must be an AbortSignal');
      result.signal = value.signal;
    }
    return result;
  }

  return function createWatch(fs: FileSystem) {
    function collect(path: string, recursive: boolean) {
      const entries = new Map<string, Stat>();
      let root: Stat;
      try { root = fs.statSync(path); } catch (error) { if (missing(error)) return entries; throw error; }
      entries.set("", root);
      if (!root.isDirectory()) return entries;
      const directories = [""];
      for (let index = 0; index < directories.length; index++) {
        const directory = directories[index];
        scan(directory, path, recursive, entries, directories);
      }
      return entries;
    }

    function scan(directory: string, path: string, recursive: boolean, entries: Map<string, Stat>, directories: string[]) {
      let names: string[];
      const current = directory ? `${path}/${directory}` : path;
      try { names = fs.readdirSync(current); } catch (error) { if (missing(error)) return; throw error; }
      for (const name of names) {
        const relative = directory ? `${directory}/${name}` : name;
        addEntry(path, relative, recursive, entries, directories);
      }
    }

    function addEntry(path: string, name: string, recursive: boolean, entries: Map<string, Stat>, directories: string[]) {
      let stat: Stat;
      try { stat = fs.lstatSync(`${path}/${name}`); } catch (error) { if (missing(error)) return; throw error; }
      entries.set(name, stat);
      if (recursive && stat.isDirectory() && !stat.isSymbolicLink()) directories.push(name);
    }

    class FSWatcher extends EventEmitter {
      #closed = false;
      #timer: ReturnType<typeof internal.timers.setInterval>;
      #entries: Map<string, Stat>;
      #path: string;
      #options: Options;
      #abort = () => this.close();

      constructor(path: string, settings: Options, listener?: Listener) {
        super();
        fs.statSync(path);
        this.#path = path;
        this.#options = settings;
        this.#entries = collect(path, Boolean(settings.recursive));
        if (listener) this.on("change", listener);
        this.#timer = internal.timers.setInterval(() => this.#poll(), 100);
        if (settings.persistent === false) this.unref();
        if (settings.signal?.aborted) internal.nextTick(this.#abort);
        else settings.signal?.addEventListener("abort", this.#abort, { once: true });
      }

      #poll() {
        if (this.#closed) return;
        let current: Map<string, Stat>;
        try { current = collect(this.#path, Boolean(this.#options.recursive)); } catch (error) { this.close(); this.emit("error", error); return; }
        const previous = this.#entries;
        this.#entries = current;
        const names = new Set(previous.keys());
        for (const name of current.keys()) names.add(name);
        for (const name of names) {
          if (this.#closed) break;
          this.#change(name, previous.get(name), current.get(name));
        }
      }

      #change(name: string, previous: Stat | undefined, current: Stat | undefined) {
        let event: "rename" | "change";
        if (!previous || !current || previous.ino !== current.ino) event = "rename";
        else if (!current.isDirectory() && (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || previous.ctimeMs !== current.ctimeMs)) event = "change";
        else return;
        const filename = name || this.#path.slice(this.#path.lastIndexOf("/") + 1);
        const encoded = Buffer.from(filename);
        this.emit("change", event, this.#options.encoding === "buffer" ? encoded : encoded.toString(this.#options.encoding));
      }

      close() {
        if (this.#closed) return;
        this.#closed = true;
        internal.timers.clearInterval(this.#timer);
        this.#options.signal?.removeEventListener("abort", this.#abort);
        internal.nextTick(() => this.emit("close"));
      }
      ref() { if (!this.#closed) this.#timer.ref(); return this; }
      unref() { if (!this.#closed) this.#timer.unref(); return this; }
    }

    function watch(path: unknown, value?: unknown, listener?: Listener) {
      if (typeof value === "function") {
        const callback = value;
        listener = function (this: unknown, ...args) { Reflect.apply(callback, this, args); };
        value = undefined;
      }
      const settings = options(value);
      return new FSWatcher(fs.absolute(fs.toPath(path)), settings, listener);
    }
    return { watch, FSWatcher };
  };
})
