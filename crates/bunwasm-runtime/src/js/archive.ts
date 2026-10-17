(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native.archive;
  type Options = { compress?: "gzip"; level?: number };
  type ExtractOptions = { glob?: string | string[] };
  type Source = Blob | ArrayBuffer | ArrayBufferView | Record<string, unknown>;

  function patterns(value: unknown): string[] {
    if (value === undefined) return [];
    if (typeof value === "string") return [value];
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
    throw new TypeError("Expected glob to be a string or an array of strings");
  }

  async function bytes(value: unknown): Promise<Uint8Array> {
    if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return internal.toUint8(value);
    return new TextEncoder().encode(String(value));
  }

  class Archive {
    #source: Source;
    #options: Options;
    #mtime = Math.floor(Date.now() / 1000);
    constructor(source: Source, options: Options = {}) {
      if (!source || typeof source !== "object") throw new TypeError("Expected an object, Blob, ArrayBuffer or TypedArray");
      if (!options || typeof options !== "object") throw new TypeError("Expected options to be an object");
      if (options.compress !== undefined && options.compress !== "gzip") throw new TypeError("Invalid compression format");
      if (options.level !== undefined && (!Number.isInteger(options.level) || options.level < 1 || options.level > 12)) {
        throw new RangeError("Compression level must be between 1 and 12");
      }
      this.#source = source;
      this.#options = { ...options };
    }
    async bytes(): Promise<Uint8Array> {
      const source = this.#source;
      if (source instanceof Blob || source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return bytes(source);
      const entries: [string, Uint8Array][] = [];
      for (const [path, content] of Object.entries(source)) entries.push([path, await bytes(content)]);
      return native.create(entries, this.#options.compress === "gzip", this.#options.level ?? 6, this.#mtime);
    }
    async blob(): Promise<Blob> {
      return new Blob([new Uint8Array(await this.bytes())], { type: "application/x-tar" });
    }
    async files(glob?: string): Promise<Map<string, File>> {
      const selected = patterns(glob);
      const result = new Map<string, File>();
      for (const entry of native.files(await this.bytes(), selected)) {
        result.set(entry.name, new File([new Uint8Array(entry.bytes)], entry.name, { lastModified: entry.mtime }));
      }
      return result;
    }
    async extract(path: string, options: ExtractOptions = {}): Promise<number> {
      if (typeof path !== "string") throw new TypeError("Expected path to be a string");
      if (!options || typeof options !== "object") throw new TypeError("Expected options to be an object");
      return native.extract(await this.bytes(), internal.require("path").resolve(path), patterns(options.glob));
    }
    static async write(path: unknown, source: Source | Archive, options?: Options): Promise<number> {
      if (arguments.length < 2) throw new TypeError("Expected path and archive data");
      const archive = source instanceof Archive ? source : new Archive(source, options);
      return internal.require("bun").write(path, await archive.bytes());
    }
    get [Symbol.toStringTag]() { return "Archive"; }
  }
  return { Archive };
})
