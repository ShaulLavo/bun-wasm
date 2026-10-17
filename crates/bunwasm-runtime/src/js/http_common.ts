(function () {
  const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const invalidValue = /[^\t\x20-\x7e\x80-\xff]/;
  const error = (code: string, message: string) => Object.assign(new TypeError(message), { code });

  function validateHeaderName(name: unknown): string {
    if (typeof name !== "string" || !token.test(name)) {
      throw error("ERR_INVALID_HTTP_TOKEN", `Header name must be a valid HTTP token ["${String(name)}"]`);
    }
    return name;
  }

  function validateHeaderValue(name: unknown, value: unknown): void {
    if (value === undefined) throw error("ERR_HTTP_INVALID_HEADER_VALUE", `Invalid value "undefined" for header "${String(name)}"`);
    if (invalidValue.test(`${value}`)) throw error("ERR_INVALID_CHAR", `Invalid character in header content ["${String(name)}"]`);
  }

  function validateMethod(method: unknown): string {
    if (typeof method !== "string") throw error("ERR_INVALID_ARG_TYPE", 'The "options.method" property must be of type string.');
    if (!token.test(method)) throw error("ERR_INVALID_HTTP_TOKEN", `Method must be a valid HTTP token ["${method}"]`);
    return method.toUpperCase();
  }

  function validatePath(path: unknown): string {
    const value = String(path);
    if (/[^\x21-\xff]/.test(value)) throw error("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
    return value;
  }

  function validateStatus(status: unknown, message: unknown): { status: number; message: string | undefined } {
    const code = Number(status);
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw Object.assign(new RangeError(`Invalid status code: ${String(status)}`), { code: "ERR_HTTP_INVALID_STATUS_CODE" });
    }
    if (message !== undefined && invalidValue.test(String(message))) throw error("ERR_INVALID_CHAR", "Invalid character in statusMessage");
    return { status: code, message: message === undefined ? undefined : String(message) };
  }

  function outgoingHeaders(headers: Iterable<readonly [string, unknown]>, unique: readonly string[] = []): [string, string][] {
    const names = new Set(unique.map(name => name.toLowerCase()));
    const pairs: [string, string][] = [];
    for (const [name, value] of Object.entries(Object.fromEntries(headers))) {
      const values: readonly unknown[] = Array.isArray(value) ? value : [value];
      if (name.toLowerCase() === "cookie" || names.has(name.toLowerCase())) {
        pairs.push([name, values.map(String).join("; ")]);
        continue;
      }
      for (const item of values) pairs.push([name, String(item)]);
    }
    return pairs;
  }

  return { validateHeaderName, validateHeaderValue, validateMethod, validatePath, validateStatus, outgoingHeaders };
})
