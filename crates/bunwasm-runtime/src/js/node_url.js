// node:url: WHATWG URL plus Node's file-URL helpers and the legacy
// url.parse/format/resolve API.
(function (internal) {
  "use strict";
  const native = internal.native;

  function invalidArg(name, expected, value) {
    const err = new TypeError(`The "${name}" argument must be ${expected}. Received ${internal.describe(value)}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    return err;
  }

  function fileURLToPath(input) {
    const url = typeof input === "string" ? new URL(input) : input;
    if (!(url instanceof URL)) throw invalidArg("path", "of type string or an instance of URL", input);
    if (url.protocol !== "file:") {
      const err = new TypeError("The URL must be of scheme file");
      err.code = "ERR_INVALID_URL_SCHEME";
      throw err;
    }
    if (url.hostname !== "" && url.hostname !== "localhost") {
      const err = new TypeError(`File URL host must be "localhost" or empty on linux`);
      err.code = "ERR_INVALID_FILE_URL_HOST";
      throw err;
    }
    if (/%2f/i.test(url.pathname)) {
      const err = new TypeError("File URL path must not include encoded / characters");
      err.code = "ERR_INVALID_FILE_URL_PATH";
      throw err;
    }
    return decodeURIComponent(url.pathname);
  }

  function pathToFileURL(path) {
    const resolved = internal.require("path").resolve(String(path));
    const withSlash = String(path).endsWith("/") && !resolved.endsWith("/") ? resolved + "/" : resolved;
    const encoded = withSlash.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/\t/g, "%09");
    const url = new URL("file://");
    url.pathname = encoded;
    return url;
  }

  // --- legacy API -------------------------------------------------------------

  class Url {
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

  const SLASHED_PROTOCOLS = new Set(["http:", "https:", "ftp:", "gopher:", "file:", "ws:", "wss:"]);

  function parse(input, parseQueryString = false, slashesDenoteHost = false) {
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

  function format(obj, options) {
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
    if (!search && obj.query && typeof obj.query === "object") {
      const qs = internal.builtin("node:querystring").stringify(obj.query);
      if (qs) search = "?" + qs;
    } else if (!search && typeof obj.query === "string" && obj.query) {
      search = "?" + obj.query;
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

  function resolve(from, to) {
    const base = new URL(from, "resolve://");
    const resolved = new URL(to, base);
    if (resolved.protocol === "resolve:") {
      const { pathname, search, hash } = resolved;
      return pathname + search + hash;
    }
    return resolved.href;
  }

  function urlToHttpOptions(url) {
    const options = {
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
    resolveObject: (from, to) => parse(resolve(from, to)),
    domainToASCII: (domain) => native.domainToASCII(String(domain)),
    domainToUnicode: (domain) => String(domain),
    urlToHttpOptions,
  };
})
