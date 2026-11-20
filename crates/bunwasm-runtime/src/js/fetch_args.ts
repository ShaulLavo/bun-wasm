// fetch()'s arguments, read and checked as Bun reads them: fetch_impl in Bun's
// src/runtime/webcore/fetch.rs. A plain object first argument is a request init with a
// `url`. Bun's own options (decompress, tls, unix, timeout, keepalive, verbose, proxy, ...)
// are read in Bun's order, from the init and then that object, so a throwing getter or a
// bad value rejects the call before anything is sent. See docs/bun-patches/fetch-args.md.
(function () {
  "use strict";

  type Source = Record<string, unknown>;
  type Deps = {
    Request: new (...args: never[]) => FetchRequest;
    Headers: new (init?: unknown) => unknown;
    AbortSignal: abstract new (...args: never[]) => AbortSignal;
    Blob: abstract new (...args: never[]) => Blob;
  };
  type FetchRequest = { url: string; method: string; redirect: string; bodyUsed: boolean };
  type Parsed =
    | { data: string }
    | { url: string; request: FetchRequest | null; init: Source };

  const REDIRECTS = ["follow", "manual", "error"];
  const PROTOCOLS = ["http2", "h2", "http3", "h3", "http1.1", "h1"];
  const COMPRESSIONS = ["gzip", "deflate", "br", "zstd"];
  const TLS_FILES = ["ca", "cert", "key"];

  function codedTypeError(message: string, code: string): TypeError {
    return Object.assign(new TypeError(message), { code });
  }

  function isObject(value: unknown): value is Source {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  // Bun's StringOrURL: a string as given, anything else through ToString when it names a URL.
  function urlOf(value: unknown): string | null {
    if (typeof value === "string") return value;
    const text = String(value);
    if (text === "" || !URL.canParse(text)) return null;
    return new URL(text).href;
  }

  function firstDefined(sources: readonly Source[], name: string, accept: (value: unknown) => boolean): unknown {
    for (const source of sources) {
      const value = source[name];
      if (value !== undefined && accept(value)) return value;
    }
    return undefined;
  }

  function isTlsFile(value: unknown, deps: Deps): boolean {
    return typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof deps.Blob;
  }

  function checkTlsFile(name: string, value: unknown, deps: Deps): void {
    if (value === undefined || value === null || isTlsFile(value, deps)) return;
    if (!Array.isArray(value)) {
      throw codedTypeError(`TLSOptions.${name} must be of type string, ArrayBuffer, Blob, array of <string, ArrayBuffer, or Blob>, or null`, "ERR_INVALID_ARG_TYPE");
    }
    for (const item of value) {
      if (!isTlsFile(item, deps)) throw codedTypeError(`element of TLSOptions.${name} must be of type string, ArrayBuffer, or Blob`, "ERR_INVALID_ARG_TYPE");
    }
  }

  function checkTls(tls: Source, deps: Deps): void {
    for (const name of TLS_FILES) checkTlsFile(name, tls[name], deps);
    const reject = tls.rejectUnauthorized;
    if (reject !== undefined && reject !== null && typeof reject !== "boolean") throw codedTypeError("TLSOptions.rejectUnauthorized must be a boolean", "ERR_INVALID_ARG_TYPE");
    const serverName = tls.serverName;
    if (serverName !== undefined && serverName !== null && typeof serverName !== "string") throw codedTypeError("TLSOptions.serverName must be a string", "ERR_INVALID_ARG_TYPE");
    const passphrase = tls.passphrase;
    if (passphrase !== undefined && passphrase !== null && typeof passphrase !== "string") throw codedTypeError("TLSOptions.passphrase must be a string", "ERR_INVALID_ARG_TYPE");
  }

  function checkCompress(value: unknown): void {
    if (typeof value === "boolean") return;
    if (typeof value === "string") {
      if (!COMPRESSIONS.includes(value)) throw codedTypeError(`fetch: 'compress' must be "gzip", "deflate", "br", or "zstd"`, "ERR_INVALID_ARG_TYPE");
      return;
    }
    if (isObject(value)) {
      const encoding = value.encoding;
      if (typeof encoding !== "string" || !COMPRESSIONS.includes(encoding)) {
        throw codedTypeError(`fetch: 'compress.encoding' must be "gzip", "deflate", "br", or "zstd"`, "ERR_INVALID_ARG_TYPE");
      }
      return;
    }
    const received = typeof value === "number" ? `type number (${String(value)})` : `type ${typeof value}`;
    throw codedTypeError(`The "compress" argument must be of type boolean, string, or object. Received ${received}`, "ERR_INVALID_ARG_TYPE");
  }

  function checkMaxRedirects(value: unknown): void {
    if (typeof value === "number" && value >= 0 && Number.isInteger(value)) return;
    throw codedTypeError("fetch: 'maxRedirects' must be a non-negative integer", "ERR_INVALID_ARG_TYPE");
  }

  // Bun's parse_proxy: a string or URL names the proxy, `{ url }` too; other values are ignored.
  function proxyOf(value: unknown): string | null {
    if (value === false || value === null) return null;
    let href: unknown = null;
    if (typeof value === "string" || value instanceof URL) href = String(value);
    else if (isObject(value)) href = value.url;
    if (href === undefined || href === null || href === "") return null;
    const text = String(href);
    if (!URL.canParse(text)) throw codedTypeError("fetch() proxy URL is invalid", "ERR_INVALID_ARG_VALUE");
    return text;
  }

  function readProxy(sources: readonly Source[]): string | null {
    for (const source of sources) {
      const value = source.proxy;
      if (value === undefined) continue;
      const proxy = proxyOf(value);
      if (proxy !== null) return proxy;
    }
    return null;
  }

  // WebIDL `AbortSignal?`: a present null detaches, anything else must be an AbortSignal.
  function signalOf(source: Source, deps: Deps): { found: boolean; signal: AbortSignal | null } {
    const value = source.signal;
    if (value === undefined) return { found: false, signal: null };
    if (value === null) return { found: true, signal: null };
    if (value instanceof deps.AbortSignal) return { found: true, signal: value };
    throw codedTypeError("signal is not of type AbortSignal.", "ERR_INVALID_ARG_TYPE");
  }

  function readSignal(options: Source | null, request: FetchRequest | null, requestInit: Source | null, init: Source, deps: Deps): void {
    const fromOptions = options ? signalOf(options, deps) : null;
    if (fromOptions?.found) {
      init.signal = fromOptions.signal;
      return;
    }
    if (request || !requestInit) return;
    const fromInit = signalOf(requestInit, deps);
    if (fromInit.found) init.signal = fromInit.signal;
  }

  function readMethod(options: Source | null, request: FetchRequest | null, requestInit: Source | null): unknown {
    const fromOptions = options ? options.method : undefined;
    if (fromOptions) return fromOptions;
    if (request) return undefined;
    const fromInit = requestInit ? requestInit.method : undefined;
    return fromInit || undefined;
  }

  function readRedirect(sources: readonly Source[]): unknown {
    for (const source of sources) {
      const value = source.redirect;
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !REDIRECTS.includes(value)) {
        throw codedTypeError("redirect must be one of 'follow', 'manual' or 'error'", "ERR_INVALID_ARG_TYPE");
      }
      return value;
    }
    return undefined;
  }

  function readBody(options: Source | null, request: FetchRequest | null, requestInit: Source | null): unknown {
    const fromOptions = options ? options.body : undefined;
    if (fromOptions !== undefined) return fromOptions;
    if (request) {
      if (request.bodyUsed) throw codedTypeError("Request body already used", "ERR_BODY_ALREADY_USED");
      return undefined;
    }
    return requestInit ? requestInit.body : undefined;
  }

  function readHeaders(options: Source | null, request: FetchRequest | null, requestInit: Source | null, deps: Deps): unknown {
    const fromOptions = options ? options.headers : undefined;
    if (fromOptions !== undefined) return new deps.Headers(fromOptions);
    if (request || !requestInit) return undefined;
    const fromInit = requestInit.headers;
    return fromInit === undefined ? undefined : new deps.Headers(fromInit);
  }

  const isNumberOrBoolean = (value: unknown) => typeof value === "boolean" || typeof value === "number";

  // Bun's options from decompress to timeout, in fetch_impl's order. They change nothing here
  // (the host has no such settings), but their getters run and bad values reject. Returns
  // whether a unix socket path was given.
  function readBunOptions(sources: readonly Source[], deps: Deps): boolean {
    firstDefined(sources, "decompress", isNumberOrBoolean);
    const compress = firstDefined(sources, "compress", () => true);
    if (compress !== undefined) checkCompress(compress);
    const maxRedirects = firstDefined(sources, "maxRedirects", (value) => value !== null);
    if (maxRedirects !== undefined) checkMaxRedirects(maxRedirects);
    const tls = firstDefined(sources, "tls", isObject);
    if (isObject(tls)) checkTls(tls, deps);
    const unix = firstDefined(sources, "unix", (value) => typeof value === "string" && value !== "");
    const protocol = firstDefined(sources, "protocol", (value) => typeof value === "string");
    if (typeof protocol === "string" && !PROTOCOLS.includes(protocol)) {
      throw codedTypeError(`fetch: 'protocol' must be "http2", "h2", "http3", "h3", "http1.1", or "h1"`, "ERR_INVALID_ARG_TYPE");
    }
    firstDefined(sources, "timeout", isNumberOrBoolean);
    return unix !== undefined;
  }

  function parse(args: ArrayLike<unknown>, deps: Deps): Parsed {
    if (args.length === 0) throw codedTypeError("fetch() expects a string but received no arguments.", "ERR_MISSING_ARGS");
    const first = args[0];
    const second = args[1];
    const options = isObject(second) ? second : null;
    const request = first instanceof deps.Request ? first : null;
    const given = request ? null : urlOf(first);
    const requestInit = request || given !== null || !isObject(first) ? null : first;
    let url = given ?? (request ? request.url : "");
    if (requestInit) {
      const value = requestInit.url;
      if (value !== undefined) url = String(value);
    }
    if (url === "") throw codedTypeError("fetch() URL must not be a blank string.", "ERR_INVALID_URL");
    if (url.startsWith("data:")) return { data: url };
    if (!URL.canParse(url)) throw codedTypeError("fetch() URL is invalid", "ERR_INVALID_URL");

    const sources = [options, requestInit].filter(isObject);
    const init: Source = {};
    const method = readMethod(options, request, requestInit);
    if (method !== undefined) init.method = method;
    const unix = readBunOptions(sources, deps);
    const redirect = readRedirect(sources);
    if (redirect !== undefined) init.redirect = redirect;
    firstDefined(sources, "keepalive", isNumberOrBoolean);
    firstDefined(sources, "verbose", (value) => typeof value === "boolean" || typeof value === "string");
    const proxy = readProxy(sources);
    readSignal(options, request, requestInit, init, deps);
    const body = readBody(options, request, requestInit);
    if (body !== undefined) init.body = body;
    const headers = readHeaders(options, request, requestInit, deps);
    if (headers !== undefined) init.headers = headers;
    if (proxy !== null && unix) throw codedTypeError("fetch() cannot use a proxy with a unix socket.", "ERR_INVALID_ARG_VALUE");
    const verb = String(init.method ?? (request ? request.method : "GET")).toUpperCase();
    if (body !== undefined && body !== null && (verb === "GET" || verb === "HEAD")) {
      throw codedTypeError("fetch() request with GET/HEAD method cannot have body.", "ERR_INVALID_ARG_VALUE");
    }
    return { url, request, init };
  }

  // A data: URL's body, or Bun's error for a malformed one (no comma, bad base64).
  function dataUrlParts(url: string): { type: string; base64: boolean; data: string } {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("failed to fetch the data URL");
    const meta = url.slice(5, comma);
    const base64 = /;\s*base64\s*$/i.test(meta);
    const type = (base64 ? meta.slice(0, meta.lastIndexOf(";")) : meta).trim();
    const data = url.slice(comma + 1);
    if (base64 && !isForgivingBase64(data)) throw new Error("failed to fetch the data URL");
    return { type: type || "text/plain;charset=US-ASCII", base64, data };
  }

  // The WHATWG forgiving-base64 decode's validity rules.
  function isForgivingBase64(encoded: string): boolean {
    let text: string;
    try {
      text = decodeURIComponent(encoded);
    } catch {
      return false;
    }
    text = text.replace(/[\t\n\f\r ]/g, "");
    if (text.length % 4 === 0) text = text.replace(/={1,2}$/, "");
    if (text.length % 4 === 1) return false;
    return /^[A-Za-z0-9+/]*$/.test(text);
  }

  return { parse, dataUrlParts };
})
