// node:url: WHATWG URL plus Node's file-URL helpers and the legacy
// url.parse/format/resolve API.
(function (internal: BunWasm.Internal) {
  "use strict";
  type HttpOptions = Record<string, string | number>;
  type UrlFields = { [Key in "protocol" | "auth" | "host" | "port" | "hostname" | "hash" | "search" | "pathname"]?: string | null } & { slashes?: boolean | null; query?: unknown };
  const native = internal.native;

  function invalidArg(name: string, expected: string, value: unknown) {
    return Object.assign(new TypeError(`The "${name}" argument must be ${expected}. Received ${internal.describe(value)}`), { code: "ERR_INVALID_ARG_TYPE" });
  }

  function fileURLToPath(input: unknown) {
    if (typeof input !== "string" && !(input instanceof URL)) throw invalidArg("url", "of type string", input);
    const url = typeof input === "string" ? URL.parse(input) : input;
    if (!url || url.protocol !== "file:") {
      throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
    }
    if (url.hostname !== "" && url.hostname !== "localhost") {
      throw Object.assign(new TypeError(`File URL host must be "localhost" or empty on linux`), { code: "ERR_INVALID_FILE_URL_HOST" });
    }
    if (/%2f/i.test(url.pathname)) {
      throw Object.assign(new TypeError("File URL path must not include encoded / characters"), { code: "ERR_INVALID_FILE_URL_PATH" });
    }
    return decodeURIComponent(url.pathname);
  }

  function pathToFileURL(path: unknown) {
    const resolved = internal.require("path").resolve(String(path));
    const withSlash = String(path).endsWith("/") && !resolved.endsWith("/") ? resolved + "/" : resolved;
    const encoded = withSlash.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/\t/g, "%09");
    const url = new URL("file://");
    url.pathname = encoded;
    return url;
  }

  // --- legacy API -------------------------------------------------------------

  class Url {
    declare protocol: string | null;
    declare slashes: boolean | null;
    declare auth: string | null;
    declare host: string | null;
    declare port: string | null;
    declare hostname: string | null;
    declare hash: string | null;
    declare search: string | null;
    declare query: string | Record<string, unknown> | null;
    declare pathname: string | null;
    declare path: string | null;
    declare href: string | null;
    constructor() {
      this.protocol = null;
      this.slashes = null;
      this.auth = null;
      this.host = null;
      this.port = null;
      this.hostname = null;
      this.hash = null;
      this.search = null;
      this.query = null;
      this.pathname = null;
      this.path = null;
      this.href = null;
    }
  }

  const SLASHED_PROTOCOLS = new Set<string | null>(["http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"]);

  function parse(input: unknown, parseQueryString = false, slashesDenoteHost = false): Url {
    if (input instanceof Url) return input;
    if (typeof input !== "string") throw invalidArg("url", "of type string", input);
    const result = new Url();
    let rest = input.trim();

    const hashAt = rest.indexOf("#");
    if (hashAt >= 0) {
      result.hash = rest.slice(hashAt);
      rest = rest.slice(0, hashAt);
    }
    const queryAt = rest.indexOf("?");
    if (queryAt >= 0) {
      result.search = rest.slice(queryAt);
      result.query = rest.slice(queryAt + 1);
      rest = rest.slice(0, queryAt);
    } else if (parseQueryString) {
      result.search = "";
      result.query = {};
    }
    if (parseQueryString && typeof result.query === "string") {
      result.query = internal.builtin("node:querystring").parse(result.query);
    }

    const proto = /^([a-z0-9.+-]+:)/i.exec(rest);
    if (proto) {
      result.protocol = proto[1].toLowerCase();
      rest = rest.slice(proto[1].length);
    }
    const hasSlashes = rest.startsWith("//");
    if (hasSlashes && (result.protocol === null ? slashesDenoteHost : true)) {
      result.slashes = true;
      rest = rest.slice(2);
      const end = rest.search(/[/]/);
      let authority = end < 0 ? rest : rest.slice(0, end);
      rest = end < 0 ? "" : rest.slice(end);
      const at = authority.lastIndexOf("@");
      if (at >= 0) {
        result.auth = decodeURIComponent(authority.slice(0, at));
        authority = authority.slice(at + 1);
      }
      const portMatch = /:(\d*)$/.exec(authority);
      if (portMatch) {
        if (portMatch[1]) result.port = portMatch[1];
        authority = authority.slice(0, portMatch.index);
      }
      result.hostname = authority.toLowerCase();
      result.host = result.hostname + (result.port ? ":" + result.port : "");
    }
    if (rest || result.host) {
      result.pathname = rest || (SLASHED_PROTOCOLS.has(result.protocol) ? "/" : rest);
    }
    if (result.pathname === "" && !result.host) result.pathname = null;
    const search = result.search || "";
    result.path = result.pathname === null && !search ? null : (result.pathname || "") + search;
    result.href = format(result);
    return result;
  }

  function format(obj: string | URL | UrlFields, options?: Partial<Record<"auth" | "fragment" | "search", boolean>>) {
    if (typeof obj === "string") obj = parse(obj);
    if (obj instanceof URL) {
      const opts = options || {};
      const url = new URL(obj.href);
      if (opts.auth === false) {
        url.username = "";
        url.password = "";
      }
      if (opts.fragment === false) url.hash = "";
      if (opts.search === false) url.search = "";
      return url.href;
    }
    let auth = obj.auth ? encodeURIComponent(obj.auth).replace(/%3A/i, ":") + "@" : "";
    const protocol = obj.protocol ? (obj.protocol.endsWith(":") ? obj.protocol : obj.protocol + ":") : "";
    let host = "";
    if (obj.host) host = auth + obj.host;
    else if (obj.hostname) host = auth + obj.hostname + (obj.port ? ":" + obj.port : "");
    auth = "";
    let pathname = obj.pathname || "";
    let search = obj.search || "";
    if (!search && obj.query && typeof obj.query === "object" && Object.keys(obj.query).length) {
      const qs = new internal.web.URLSearchParams(obj.query).toString();
      if (qs) search = "?" + qs;
    }
    if (search && !search.startsWith("?")) search = "?" + search;
    let hash = obj.hash || "";
    if (hash && !hash.startsWith("#")) hash = "#" + hash;
    const slashes = obj.slashes || SLASHED_PROTOCOLS.has(protocol);
    if (slashes && (host || protocol === "file:")) {
      host = "//" + host;
      if (pathname && !pathname.startsWith("/")) pathname = "/" + pathname;
    }
    pathname = pathname.replace(/[?#]/g, encodeURIComponent);
    search = search.replace(/#/g, "%23");
    return protocol + host + pathname + search + hash;
  }

  function resolve(from: string, to: string) {
    const base = new URL(from, "resolve://");
    const resolved = new URL(to, base);
    if (resolved.protocol === "resolve:") {
      const { pathname, search, hash } = resolved;
      return pathname + search + hash;
    }
    return resolved.href;
  }

  function urlToHttpOptions(url: URL) {
    const options: HttpOptions = {
      protocol: url.protocol,
      hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
      hash: url.hash,
      search: url.search,
      pathname: url.pathname,
      path: `${url.pathname || ""}${url.search || ""}`,
      href: url.href,
    };
    if (url.port !== "") options.port = Number(url.port);
    if (url.username || url.password) options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    return options;
  }

  return {
    URL,
    URLSearchParams,
    Url,
    fileURLToPath,
    pathToFileURL,
    parse,
    format,
    resolve,
    resolveObject: (from: string, to: string) => parse(resolve(from, to)),
    domainToASCII: (domain: unknown) => native.domainToASCII(String(domain)),
    domainToUnicode: (domain: unknown) => native.domainToUnicode(`${domain}`),
    urlToHttpOptions,
  };
})
