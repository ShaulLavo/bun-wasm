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

  const hrefGetter = Object.getOwnPropertyDescriptor(URL.prototype, "href")?.get;

  function isURL(value: unknown): value is URL {
    if (!hrefGetter) return false;
    try { hrefGetter.call(value); return true; }
    catch { return false; }
  }

  function fileURLToPath(input: unknown) {
    if (typeof input !== "string" && !isURL(input)) throw invalidArg("url", "of type string", input);
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
  const UNSAFE_PROTOCOLS = new Set<string | null>(["javascript:"]);
  const codes = (text: string) => new Set(Array.from(text, (char) => char.charCodeAt(0)));
  // Bun's legacy parser (vendor/bun/src/js/node/url.ts): characters never allowed in a host
  // end it, as do the host-ending /, ? and #. Forbidden sets apply after IDNA.
  const NON_HOST = codes(" \"%';<>\\^`{|}");
  const HOST_END = codes("#/?");
  const FORBIDDEN_HOST = codes("\0\t\n\r #%/:<>?@[\\]^|");
  const FORBIDDEN_IPV6_HOST = codes("\0\t\n\r #%/<>?@\\^|");
  const HOSTNAME_END = codes("/\\#?:");
  const AUTO_ESCAPE = /['{}|\\^`<>" \r\n\t]/g;
  const HOSTNAME_MAX_LENGTH = 255;

  function invalidURL(input: string): TypeError {
    return internal.require("url_errors").invalidURL(input);
  }

  function hasCode(text: string, set: Set<number>) {
    for (let i = 0; i < text.length; i++) if (set.has(text.charCodeAt(i))) return true;
    return false;
  }

  function hasNonAscii(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return true;
    return false;
  }

  /** The last @ before a host-ending character ends the auth; the first non-host character ends the host. */
  function splitAuthority(text: string) {
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 64) {
        atSign = i;
        nonHost = -1;
        continue;
      }
      if (nonHost === -1 && (NON_HOST.has(code) || HOST_END.has(code))) nonHost = i;
      if (HOST_END.has(code)) break;
    }
    const end = nonHost === -1 ? text.length : nonHost;
    return { auth: atSign === -1 ? null : text.slice(0, atSign), host: text.slice(atSign + 1, end), rest: text.slice(end) };
  }

  /** Bun's getHostname: a hostname character that cannot appear there moves the remainder into the path. */
  function cutHostname(hostname: string, rest: string) {
    for (let i = 0; i < hostname.length; i++) {
      if (HOSTNAME_END.has(hostname.charCodeAt(i))) return { hostname: hostname.slice(0, i), rest: `/${hostname.slice(i)}${rest}` };
    }
    return { hostname, rest };
  }

  function asciiHostname(hostname: string, input: string) {
    const ascii = hasNonAscii(hostname) ? native.domainToASCII(hostname) : hostname;
    if (ascii === "" || hasCode(ascii, FORBIDDEN_HOST)) throw invalidURL(input);
    return ascii;
  }

  function autoEscape(text: string) {
    return text.replace(AUTO_ESCAPE, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  }

  /** Bun escapes these characters before splitting the hash and query, so each part gets the same escape. */
  function escapeParts(result: Url) {
    if (result.hash) result.hash = autoEscape(result.hash);
    if (result.search) result.search = autoEscape(result.search);
    if (typeof result.query === "string") result.query = autoEscape(result.query);
  }

  /** Parses the authority after `//` into result and returns the post-host remainder. */
  function parseAuthority(result: Url, text: string, input: string) {
    const lineEnd = text.search(/[#/?]/);
    const head = lineEnd < 0 ? text : text.slice(0, lineEnd);
    const split = splitAuthority(head.replace(/[\t\n\r]/g, "") + (lineEnd < 0 ? "" : text.slice(lineEnd)));
    if (split.auth !== null) result.auth = decodeURIComponent(split.auth);
    let host = split.host;
    const portMatch = /:\d*$/.exec(host);
    if (portMatch) {
      if (portMatch[0] !== ":") result.port = portMatch[0].slice(1);
      host = host.slice(0, portMatch.index);
    }
    const ipv6 = host.startsWith("[") && host.endsWith("]");
    const cut = ipv6 ? { hostname: host, rest: split.rest } : cutHostname(host, split.rest);
    let rest = cut.rest;
    let hostname = cut.hostname.length > HOSTNAME_MAX_LENGTH ? "" : cut.hostname.toLowerCase();
    if (hostname !== "" && ipv6 && hasCode(hostname, FORBIDDEN_IPV6_HOST)) throw invalidURL(input);
    if (hostname !== "" && !ipv6) hostname = asciiHostname(hostname, input);
    result.host = hostname + (result.port ? ":" + result.port : "");
    result.hostname = ipv6 ? hostname.slice(1, -1) : hostname;
    if (ipv6 && !rest.startsWith("/")) rest = "/" + rest;
    return rest;
  }

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
      rest = parseAuthority(result, rest.slice(2), input);
    }
    if (!UNSAFE_PROTOCOLS.has(result.protocol)) {
      rest = autoEscape(rest);
      escapeParts(result);
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
    // Bun converts the query, including its accessors and value coercion, before it reads an explicit search.
    const query = obj.query;
    const queryString = query && typeof query === "object" && Object.keys(query).length
      ? new internal.web.URLSearchParams(query).toString()
      : "";
    let search = obj.search || "";
    if (!search && queryString) search = "?" + queryString;
    if (search && !search.startsWith("?")) search = "?" + search;
    let hash = obj.hash || "";
    if (hash && !hash.startsWith("#")) hash = "#" + hash;
    const slashes = obj.slashes || SLASHED_PROTOCOLS.has(protocol);
    if (slashes && (obj.slashes || host || protocol === "file:")) {
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
    Object.setPrototypeOf(options, null);
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
