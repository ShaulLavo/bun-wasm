(function () {
  "use strict";
  type Pair = [string, string];

  function toUSVString(value: unknown): string {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, part => part.length === 2 ? part : "\uFFFD");
  }

  function convertMethodArgs(readList: () => Pair[], name: unknown, value?: unknown, requiredValue = false): [string, string | undefined] {
    readList();
    const key = toUSVString(name);
    const converted = value === undefined && !requiredValue ? undefined : toUSVString(value);
    return [key, converted];
  }

  function sequence(value: object, iterator: Function): Iterable<unknown> {
    return { [Symbol.iterator]: () => Reflect.apply(iterator, value, []) };
  }

  function convertPair(value: unknown): string[] {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      throw Object.assign(new TypeError("Value is not a sequence"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const iterator: unknown = Reflect.get(value, Symbol.iterator);
    if (typeof iterator !== "function") throw new TypeError("Type error");
    return Array.from(sequence(value, iterator), toUSVString);
  }

  function checkedPair(value: string[]): Pair {
    if (value.length !== 2) throw new TypeError("Type error");
    return [value[0], value[1]];
  }

  function initFromObject(init: object): Pair[] {
    const iterator: unknown = Reflect.get(init, Symbol.iterator);
    if (iterator != null) {
      if (typeof iterator !== "function") throw new TypeError("Symbol.iterator property should be callable");
      return Array.from(sequence(init, iterator), convertPair).map(checkedPair);
    }
    const entries = new Map<string, string>();
    for (const key of Reflect.ownKeys(init)) {
      if (!Object.prototype.propertyIsEnumerable.call(init, key)) continue;
      if (typeof key === "symbol") throw new TypeError("Cannot convert a symbol to a string");
      entries.set(toUSVString(key), toUSVString(Reflect.get(init, key)));
    }
    return Array.from(entries);
  }

  type Inspect = (value: unknown, options?: object) => string;
  type InspectOptions = { depth?: number | null; breakLength?: number };

  // Node's URLSearchParams[util.inspect.custom] (lib/internal/url.js): `Name { 'k' => 'v' }`,
  // one entry per line once the entries are longer than the break length.
  function inspectParams(name: string, pairs: readonly Pair[], depth: number | null, options: InspectOptions | undefined, inspect: Inspect): string {
    if (typeof depth === "number" && depth < 0) return "[Object]";
    const inner = Object.assign({}, options, { depth: depth === null ? null : depth - 1 });
    const output = pairs.map(([key, value]) => `${inspect(key, inner)} => ${inspect(value, inner)}`);
    if (output.length === 0) return `${name} {}`;
    // oxlint-disable-next-line no-control-regex -- Colors are measured without their escape sequences.
    const length = output.reduce((total, item) => total + item.replace(/\u001b\[[0-9;]*m/g, "").length + 2, -2);
    const breakLength = typeof options?.breakLength === "number" ? options.breakLength : 80;
    if (length > breakLength) return `${name} {\n  ${output.join(",\n  ")} }`;
    return `${name} { ${output.join(", ")} }`;
  }

  type URLView = { href: string; protocol: string; username: string; password: string; hostname: string; port: string; pathname: string };

  const OMITTED = 4294967295;
  const SCHEME_TYPES: Record<string, number> = { "http:": 0, "https:": 2, "ws:": 3, "ftp:": 4, "wss:": 5, "file:": 6 };

  // Node's URLContext (lib/internal/url.js), which util.inspect shows with showHidden.
  class URLContext {
    href = "";
    protocol_end = 0;
    username_end = 0;
    host_start = 0;
    host_end = 0;
    pathname_start = 0;
    search_start = OMITTED;
    hash_start = OMITTED;
    port = OMITTED;
    scheme_type = 1;
    get hasPort() {
      return this.port !== OMITTED;
    }
    get hasSearch() {
      return this.search_start !== OMITTED;
    }
    get hasHash() {
      return this.hash_start !== OMITTED;
    }
  }

  // ada's component offsets into the href, rebuilt from the URL's getters the way
  // Bun's JSDOMURL.cpp jsDOMURLMakeURLContext does.
  function urlContext(url: URLView): URLContext {
    const { href, protocol, username, password, hostname, port, pathname } = url;
    const context = new URLContext();
    const hasSlashes = href.startsWith("//", protocol.length);
    const usernameEnd = protocol.length + (hasSlashes ? 2 : 0) + username.length;
    const hostStart = usernameEnd + (password === "" ? 0 : 1 + password.length);
    const hostEnd = hostStart + (username === "" && password === "" ? 0 : 1) + hostname.length;
    // URL Standard 4.5 step 3: a null host with an empty first path segment serializes
    // with a "/." guard that the pathname getter omits.
    const guard = !hasSlashes && pathname.startsWith("//") && href.startsWith("/.", protocol.length) ? 2 : 0;
    const pathnameStart = hostEnd + (port === "" ? 0 : 1 + port.length) + guard;
    const pathnameEnd = pathnameStart + pathname.length;
    // search and hash read "" for both a missing and an empty component; the href keeps the delimiter.
    const hashAt = href.indexOf("#");
    const queryEnd = hashAt === -1 ? href.length : hashAt;
    Object.assign(context, {
      href,
      protocol_end: protocol.length,
      username_end: usernameEnd,
      host_start: hostStart,
      host_end: hostEnd,
      pathname_start: pathnameStart,
      search_start: queryEnd > pathnameEnd && href[pathnameEnd] === "?" ? pathnameEnd : OMITTED,
      hash_start: hashAt === -1 ? OMITTED : hashAt,
      port: port === "" ? OMITTED : Number(port),
      scheme_type: SCHEME_TYPES[protocol] ?? 1,
    });
    return context;
  }

  return { toUSVString, initFromObject, convertMethodArgs, inspectParams, urlContext };
})
