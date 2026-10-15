(function (internal) {
  "use strict";

  // Port of the pinned Bun Cookie.cpp, CookieMap.cpp and their JS bindings.
  const cookies = new WeakMap();
  const maps = new WeakMap();
  const asciiWhitespace = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
  const validName = /^[\x21-\x3a\x3c\x3e-\x7e]+$/;
  const validPath = /^[\x20-\x3a\x3d-\x7e]*$/;
  const validDomain = /^[a-z0-9.-]*$/;

  function plainString(value) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }

  function string(value) {
    return plainString(value).replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (s) => s.length === 2 ? s : "\ufffd");
  }

  function trim(value) {
    return value.replace(asciiWhitespace, "");
  }

  function validate(value, pattern, field) {
    if (!pattern.test(value)) throw new TypeError(`Invalid cookie ${field}: contains invalid characters`);
    return value;
  }

  function sameSite(value, ignoreCase) {
    const text = ignoreCase ? string(value).toLowerCase() : string(value);
    if (text === "strict" || text === "lax" || text === "none") return text;
    throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
  }

  function expiration(value) {
    if (value == null) return undefined;
    if (value instanceof Date) {
      if (!Number.isFinite(Date.prototype.getTime.call(value))) throw new RangeError("expires must be a valid Date (or Number)");
      return Date.prototype.getTime.call(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new RangeError("expires must be a valid Number (or Date)");
      return Math.trunc(value * 1000);
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed) || parsed === 0) throw new TypeError("Invalid cookie expiration date");
      return parsed;
    }
    const shown = globalThis.Bun.inspect(value);
    const error = new TypeError(`The argument 'expires' Invalid expires value. Must be a Date or a number. Received ${shown}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }

  function optionsState(name, value, options, checkName) {
    const state = { name, value, domain: "", path: "/", expires: undefined, maxAge: undefined, secure: false, httpOnly: false, partitioned: false, sameSite: "lax" };
    if (options == null) return state;
    if (typeof options !== "object" && typeof options !== "function") throw new TypeError("Options must be an object");
    if (checkName) {
      state.name = "name" in options ? string(options.name) : "";
      if (!state.name) throw new TypeError("name is required");
      state.value = "value" in options ? string(options.value) : "";
    }
    const domain = options.domain;
    if (domain != null) state.domain = string(domain);
    const path = options.path;
    if (path != null) state.path = string(path);
    state.expires = expiration(options.expires);
    const maxAge = options.maxAge;
    if (typeof maxAge === "number" && !Number.isNaN(maxAge)) state.maxAge = maxAge;
    state.secure = Boolean(options.secure);
    state.httpOnly = Boolean(options.httpOnly);
    state.partitioned = Boolean(options.partitioned);
    const site = options.sameSite;
    if (site != null) state.sameSite = sameSite(site, false);
    return state;
  }

  function validateState(state) {
    validate(state.name, validName, "name");
    validate(state.path, validPath, "path");
    validate(state.domain, validDomain, "domain");
    return state;
  }

  function parseAttribute(state, attribute) {
    const equals = attribute.indexOf("=");
    const name = trim(equals < 0 ? attribute : attribute.slice(0, equals)).toLowerCase();
    const value = equals < 0 ? "" : trim(attribute.slice(equals + 1));
    if (name === "domain" && value) state.domain = value.toLowerCase();
    if (name === "path" && value.startsWith("/")) state.path = value;
    if (name === "expires" && Number.isFinite(Date.parse(value))) state.expires = Date.parse(value);
    if (name === "max-age" && /^[+-]?\d+/.test(value)) {
      const integer = BigInt(value.match(/^[+-]?\d+/)[0]);
      if (integer >= -9223372036854775808n && integer <= 9223372036854775807n) state.maxAge = Number(integer);
    }
    if (name === "secure") state.secure = true;
    if (name === "httponly") state.httpOnly = true;
    if (name === "partitioned") state.partitioned = true;
    if (name === "samesite" && /^(strict|lax|none)$/i.test(value)) state.sameSite = value.toLowerCase();
  }

  function parseState(input) {
    const text = string(input);
    if (/[\0\r\n\u0100-\uffff]/.test(text)) throw new TypeError("cookie string is not a valid HTTP header value");
    if (text.length < 2) throw new TypeError("Invalid cookie string: empty");
    const parts = text.split(";");
    const equals = parts[0].indexOf("=");
    if (equals < 0) throw new TypeError("Invalid cookie string: no '=' found");
    const name = trim(parts[0].slice(0, equals));
    if (!name) throw new TypeError("Invalid cookie string: name cannot be empty");
    const state = optionsState(name, trim(parts[0].slice(equals + 1)), null, false);
    for (const attribute of parts.slice(1)) parseAttribute(state, attribute);
    return validateState(state);
  }

  function serialize(state) {
    let result = state.name + "=" + encodeURIComponent(state.value);
    if (state.domain) result += "; Domain=" + state.domain;
    if (state.path) result += "; Path=" + state.path;
    if (state.expires !== undefined) result += "; Expires=" + new Date(state.expires).toUTCString();
    if (state.maxAge !== undefined) result += "; Max-Age=" + state.maxAge;
    if (state.secure) result += "; Secure";
    if (state.httpOnly) result += "; HttpOnly";
    if (state.partitioned) result += "; Partitioned";
    return result + "; SameSite=" + state.sameSite[0].toUpperCase() + state.sameSite.slice(1);
  }

  class Cookie {
    constructor(name, value, options) {
      let state;
      if (arguments.length === 1 && typeof name === "string") state = parseState(name);
      else if (arguments.length === 1 && name !== null && (typeof name === "object" || typeof name === "function")) state = validateState(optionsState("", "", name, true));
      else if (arguments.length >= 2) {
        name = string(name);
        if (!name) throw new TypeError("name is required");
        state = validateState(optionsState(name, string(value), options, false));
      } else throw new TypeError("Not enough arguments");
      cookies.set(this, state);
    }
    static parse(input) {
      if (arguments.length === 0) throw new TypeError("Not enough arguments");
      const text = string(input);
      if (text === "") throw new TypeError("Invalid cookie name: contains invalid characters");
      return new Cookie(text);
    }
    static from(name, value, options) {
      if (arguments.length < 2) throw new TypeError("Not enough arguments");
      return new Cookie(name, value, options);
    }
    get name() { return cookies.get(this).name; }
    set name(value) {}
    get value() { return cookies.get(this).value; }
    set value(value) { cookies.get(this).value = string(value); }
    get domain() { return cookies.get(this).domain || null; }
    set domain(value) { cookies.get(this).domain = validate(string(value), validDomain, "domain"); }
    get path() { return cookies.get(this).path; }
    set path(value) { cookies.get(this).path = validate(string(value), validPath, "path"); }
    get expires() {
      const state = cookies.get(this);
      if (state.expires === undefined) return undefined;
      if (!state.date || state.date.getTime() !== state.expires) state.date = new Date(state.expires);
      return state.date;
    }
    set expires(value) { cookies.get(this).expires = expiration(value); }
    get maxAge() { return cookies.get(this).maxAge; }
    set maxAge(value) {
      const converted = value == null ? undefined : Number(value);
      if (converted !== undefined && !Number.isFinite(converted)) throw new TypeError("The provided value is non-finite");
      cookies.get(this).maxAge = converted;
    }
    get secure() { return cookies.get(this).secure; }
    set secure(value) { cookies.get(this).secure = Boolean(value); }
    get httpOnly() { return cookies.get(this).httpOnly; }
    set httpOnly(value) { cookies.get(this).httpOnly = Boolean(value); }
    get partitioned() { return cookies.get(this).partitioned; }
    set partitioned(value) { cookies.get(this).partitioned = Boolean(value); }
    get sameSite() { return cookies.get(this).sameSite; }
    set sameSite(value) { cookies.get(this).sameSite = sameSite(value, true); }
    isExpired() {
      const state = cookies.get(this);
      if (state.maxAge !== undefined) return state.maxAge <= 0;
      return state.expires !== undefined && Date.now() > state.expires;
    }
    toString() { return serialize(cookies.get(this)); }
    serialize() { return serialize(cookies.get(this)); }
    toJSON() {
      const state = cookies.get(this);
      const result = Object.create(null);
      result.name = state.name;
      result.value = state.value;
      if (state.domain) result.domain = state.domain;
      result.path = state.path;
      if (state.expires !== undefined) result.expires = new Date(state.expires);
      if (state.maxAge !== undefined) result.maxAge = state.maxAge;
      result.secure = state.secure;
      result.sameSite = state.sameSite;
      result.httpOnly = state.httpOnly;
      result.partitioned = state.partitioned;
      return result;
    }
    get [Symbol.toStringTag]() { return "Cookie"; }
  }

  function decode(value) {
    const input = new TextEncoder().encode(value);
    const bytes = [];
    for (let i = 0; i < input.length; i++) {
      if (input[i] !== 37) {
        bytes.push(input[i]);
        continue;
      }
      const hex = String.fromCharCode(input[i + 1], input[i + 2]);
      bytes.push(i + 2 < input.length && /^[\da-f]{2}$/i.test(hex) ? parseInt(hex, 16) : 255);
      if (i + 2 < input.length) i += 2;
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  function originalPairs(init) {
    if (init == null) return [];
    if (typeof init === "string") {
      const encoded = init.includes("%");
      return init.split(";").flatMap((pair) => {
        const equals = pair.indexOf("=");
        if (equals < 0 || !trim(pair.slice(0, equals))) return [];
        const value = trim(pair.slice(equals + 1));
        return [[trim(pair.slice(0, equals)), encoded ? decode(value) : value]];
      });
    }
    if (Array.isArray(init)) return init.map((pair) => {
      if (!Array.isArray(pair)) throw new TypeError("Expected each element to be an array of two strings");
      if (pair.length !== 2) throw new TypeError("Expected arrays of exactly two strings");
      return [plainString(pair[0]), plainString(pair[1])];
    });
    if (typeof init === "object" || typeof init === "function") return Object.getOwnPropertyNames(init).map((key) => [key, plainString(init[key])]);
    throw new TypeError("Invalid initializer type");
  }

  function remove(state, name) {
    state.original = state.original.filter((pair) => pair[0] !== name);
    state.modified = state.modified.filter((cookie) => cookie.name !== name);
  }

  function iterate(state, kind) {
    let index = 0;
    return {
      next() {
        while (index < state.modified.length + state.original.length) {
          const modified = index < state.modified.length;
          const pair = modified ? [state.modified[index].name, state.modified[index].value] : state.original[index - state.modified.length];
          index++;
          if (modified && !pair[1]) continue;
          return { value: kind === "key" ? pair[0] : kind === "value" ? pair[1] : pair, done: false };
        }
        return { value: undefined, done: true };
      },
      [Symbol.iterator]() { return this; },
    };
  }

  class CookieMap {
    constructor(init) { maps.set(this, { original: originalPairs(init), modified: [] }); }
    get size() {
      const state = maps.get(this);
      return state.original.length + state.modified.filter((cookie) => cookie.value !== "").length;
    }
    get(name) {
      if (arguments.length === 0) return null;
      const state = maps.get(this);
      name = string(name);
      const modified = state.modified.find((cookie) => cookie.name === name);
      if (modified) return modified.value || null;
      const original = state.original.find((pair) => pair[0] === name);
      return original ? original[1] : null;
    }
    has(name) { return arguments.length !== 0 && CookieMap.prototype.get.call(this, name) !== null; }
    set(name, value, options) {
      if (arguments.length === 0) return;
      if (typeof name !== "object" && typeof name !== "function" && arguments.length < 2) throw new TypeError("Not enough arguments");
      const cookie = cookies.has(name) ? name : typeof name === "object" && name !== null ? new Cookie(name) : new Cookie(name, value, options);
      const state = maps.get(this);
      remove(state, cookie.name);
      state.modified.push(cookie);
    }
    delete(name, options) {
      if (arguments.length === 0) return;
      if (name !== null && (typeof name === "object" || typeof name === "function")) {
        options = name;
        name = options.name;
      } else if (arguments.length > 1 && (options === null || typeof options !== "object" && typeof options !== "function")) throw new TypeError("Options must be an object");
      if (typeof name !== "string") throw new TypeError("Cookie name is required");
      const state = maps.get(this);
      remove(state, name);
      const cookie = new Cookie(name, "", { domain: options && options.domain, path: options && options.path, expires: new Date(1), secure: /^__(host|secure)-/i.test(name) });
      state.modified.push(cookie);
    }
    entries() { return iterate(maps.get(this), "entry"); }
    keys() { return iterate(maps.get(this), "key"); }
    values() { return iterate(maps.get(this), "value"); }
    [Symbol.iterator]() { return iterate(maps.get(this), "entry"); }
    forEach(callback, thisArg) {
      if (typeof callback !== "function") throw new TypeError("Expected a callback function");
      for (const [key, value] of iterate(maps.get(this), "entry")) callback.call(thisArg, value, key, this);
    }
    toJSON() {
      const result = {};
      for (const [key, value] of iterate(maps.get(this), "entry")) {
        if (Object.prototype.hasOwnProperty.call(result, key)) continue;
        Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    toSetCookieHeaders() { return maps.get(this).modified.map((cookie) => serialize(cookies.get(cookie))); }
    get [Symbol.toStringTag]() { return "CookieMap"; }
  }

  return { Cookie, CookieMap };
})
