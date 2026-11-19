// node:os value functions as Node defines them in lib/os.js: each is an ordinary named
// function whose Symbol.toPrimitive returns its value, so `${os.arch}` is the
// architecture while os.arch.toString() still prints the function.
(function () {
  "use strict";
  const names = ["arch", "availableParallelism", "endianness", "freemem", "homedir", "hostname", "machine", "platform", "release", "tmpdir", "totalmem", "type", "uptime", "version"];

  return function withPrimitiveValues<T extends Record<string, unknown>>(os: T): T {
    for (const name of names) {
      const read = os[name];
      if (typeof read !== "function") continue;
      const value = function () {
        return Reflect.apply(read, undefined, []);
      };
      Object.defineProperty(value, "name", { value: name });
      Object.defineProperty(value, Symbol.toPrimitive, { value: () => value(), writable: true, configurable: true });
      Reflect.set(os, name, value);
    }
    return os;
  };
})
