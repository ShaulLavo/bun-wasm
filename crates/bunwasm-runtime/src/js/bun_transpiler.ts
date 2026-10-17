(function (internal: {
  native: { transpilePublic(source: Uint8Array, options: string, action: string, loader: string): string; utf8Encode(source: string): Uint8Array; utf8Decode(source: Uint8Array): string };
  toUint8(source: ArrayBuffer | ArrayBufferView): Uint8Array;
}) {
  type Options = { loader?: string; target?: string; tsconfig?: unknown; [key: string]: unknown };
  type Action = "validate" | "transform" | "scan" | "scanImports";
  type Position = { file: string; line: number; column: number; lineText: string } | null;
  const javascriptLoaders = ["js", "jsx", "ts", "tsx"];
  const loaders = new Set(javascriptLoaders.concat(["json", "toml", "yaml", "json5", "jsonc", "text"]));
  const stringify = JSON.stringify, parse = JSON.parse;
  const forwardedOptions = ["define", "treeShaking", "trimUnusedImports", "replMode", "deadCodeElimination", "minifyWhitespace", "minifySyntax", "minifyIdentifiers", "allowBunRuntime", "autoImportJSX"];

  function minification(config: Options, minify: unknown) {
    if (minify === undefined || minify === null) return;
    if (typeof minify === "boolean") {
      config.minifyWhitespace = config.minifySyntax = config.minifyIdentifiers = minify;
      return;
    }
    if (typeof minify !== "object" && typeof minify !== "function") throw new TypeError("Expected minify to be a boolean or an object");
    for (const [field, option] of [["whitespace", "minifyWhitespace"], ["syntax", "minifySyntax"], ["identifiers", "minifyIdentifiers"]]) {
      const value: unknown = Reflect.get(minify, field);
      if (value !== undefined) config[option] = !!value;
    }
  }

  class BuildMessage extends Error {
    name = "BuildMessage";
    level = "error";
    position: Position;
    constructor(message: string, position: Position) {
      super(message);
      this.position = position;
    }
    toJSON() { return { name: this.name, message: this.message, level: this.level, position: this.position }; }
  }

  function loader(value: unknown, fallback: string): string {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !loaders.has(value)) throw new TypeError(`Invalid loader: ${String(value)}`);
    return value;
  }

  function source(value: unknown): Uint8Array {
    if (typeof value === "string") return internal.native.utf8Encode(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return internal.toUint8(value);
    throw new TypeError("Expected code to be a string or an ArrayBufferView");
  }

  function parseError(error: unknown, bytes: Uint8Array): Error {
    const report = error instanceof Error ? error.message : String(error);
    const lines = internal.native.utf8Decode(bytes).split("\n");
    const errors = report.trimEnd().split("\n").map(entry => {
      const match = /^(.*?):(\d+):(\d+): (.*)$/.exec(entry);
      const message = match ? match[4] : entry;
      const position = match ? { file: match[1], line: Number(match[2]), column: Number(match[3]), lineText: lines[Number(match[2]) - 1] ?? "" } : null;
      return new BuildMessage(message, position);
    });
    if (errors.length === 1) return errors[0];
    return new AggregateError(errors, "Parse error");
  }

  class Transpiler {
    #options: string;
    #loader: string;
    constructor(options: Options | null = {}) {
      if (options === null) options = {};
      if (typeof options !== "object") throw new TypeError("Expected transpiler options to be an object");
      this.#loader = loader(options.loader, "jsx");
      if (!javascriptLoaders.includes(this.#loader)) throw new TypeError("only JavaScript-like loaders supported for now");
      const target = options.target ?? "browser";
      if (target !== "bun" && target !== "node" && target !== "browser") throw new TypeError(`Invalid target: ${String(target)}`);
      const tsconfig = options.tsconfig;
      if (Array.isArray(tsconfig)) throw new TypeError("tsconfig must be a string or object");
      const config: Options = Object.create(null);
      Object.assign(config, { loader: this.#loader, target, tsconfig });
      for (const key of forwardedOptions) {
        const value = options[key];
        if (value !== undefined) config[key] = value;
      }
      minification(config, options.minify);
      this.#options = stringify(config);
      this.#request("", this.#loader, "validate");
    }
    #request(code: unknown, value: unknown, action: Action) {
      const selected = loader(value, this.#loader);
      if (action === "scanImports" && !javascriptLoaders.includes(selected)) throw new TypeError("Only JavaScript-like files support this fast path");
      const bytes = source(code);
      try {
        return internal.native.transpilePublic(bytes, this.#options, action, selected);
      } catch (error) {
        throw parseError(error, bytes);
      }
    }
    transformSync(code: unknown, value?: unknown) {
      return this.#request(code, value, "transform");
    }
    transform(code: unknown, value?: unknown) {
      const bytes = new Uint8Array(source(code)), selected = loader(value, this.#loader);
      return Promise.resolve().then(() => this.#request(bytes, selected, "transform"));
    }
    scan(code: unknown, value?: unknown) {
      return parse(this.#request(code, value, "scan"));
    }
    scanImports(code: unknown, value?: unknown) {
      return parse(this.#request(code, value, "scanImports"));
    }
  }
  Object.defineProperty(Transpiler.prototype, Symbol.toStringTag, { value: "Transpiler", configurable: true });
  return { Transpiler };
})
