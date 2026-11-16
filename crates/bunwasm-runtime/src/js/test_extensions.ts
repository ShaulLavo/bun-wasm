(function (internal: {
  isPromise(value: unknown): value is Promise<unknown>;
  promiseThen<T, U>(value: Promise<T>, fulfilled: (value: T) => U, rejected?: (error: unknown) => U): Promise<U>;
  require(name: "inspect"): { bunInspect(value: unknown): string };
  require(name: "test_matchers"): {
    settle<T, U>(value: T | Promise<T>, consume: (value: T) => U | Promise<U>): U | Promise<U>;
  };
}) {
  type Matcher = (...args: unknown[]) => unknown;
  const inspect = internal.require("inspect").bunInspect;
  const { settle } = internal.require("test_matchers");

  function register(matchers: unknown, define: (name: string, matcher: Matcher) => void) {
    if (matchers === null || typeof matchers !== "object" && typeof matchers !== "function") {
      throw new TypeError("expect.extend(matchers)\n\nExpected an object containing matchers");
    }
    if (Array.isArray(matchers)) {
      for (const name of Object.keys(matchers)) registerProperty(matchers, name, define);
      return;
    }
    const seen = new Set<string>();
    let owner = matchers;
    while (owner && owner !== Object.prototype && owner !== Function.prototype) {
      const names = typeof owner === "function" ? Object.keys(owner) : Object.getOwnPropertyNames(owner);
      for (const name of names) {
        if (seen.has(name) || (name === "constructor" && owner !== matchers)) continue;
        seen.add(name);
        registerProperty(matchers, name, define);
      }
      owner = Object.getPrototypeOf(owner);
    }
  }

  function registerProperty(matchers: object, name: string, define: (name: string, matcher: Matcher) => void) {
    const matcher: unknown = Reflect.get(matchers, name);
    if (typeof matcher !== "function") {
      const kind = matcher === null ? "null" : typeof matcher;
      throw new TypeError(`expect.extend: \`${name}\` is not a valid matcher. Must be a function, is "${kind}"`);
    }
    define(name, matcher as Matcher);
  }

  function invalidResult(name: string, result: unknown): never {
    throw new Error(`Unexpected return from matcher function \`${name}\`.\nMatcher functions should return an object in the following format:\n  {message?: string | function, pass: boolean}\n'${inspect(result)}' was returned`);
  }

  function failure(name: string, result: unknown, not: boolean) {
    if (asymmetricPass(name, result) !== not) return null;
    if (result === null || typeof result !== "object") invalidResult(name, result);
    const message: unknown = Reflect.get(result, "message");
    const value: unknown = typeof message === "function" ? message.call(result) : message;
    return { raw: true, body: value === undefined ? "No message was specified for this matcher." : String(value) };
  }

  function result(name: string, value: unknown, not: boolean) {
    return settle(value, settled => failure(name, settled, not));
  }

  function asymmetricPass(name: string, value: unknown): boolean {
    if (value === null || typeof value !== "object") invalidResult(name, value);
    const pass: unknown = Reflect.get(value, "pass");
    if (pass === undefined || internal.isPromise(pass)) invalidResult(name, value);
    return !!pass;
  }

  function asymmetric(name: string, value: unknown, diagnostic: (error: unknown) => void): boolean | Promise<boolean> {
    if (!internal.isPromise(value)) return asymmetricPass(name, value);
    // Attach both intrinsic reactions before validation or any user continuation.
    return internal.promiseThen(value, settled => asymmetricPass(name, settled), error => {
      diagnostic(error);
      throw new Error(`Matcher \`${name}\` returned a promise that rejected`);
    });
  }

  function context(not: boolean, promise: string | undefined, equals: (a: unknown, b: unknown) => boolean | Promise<boolean>) {
    return {
      isNot: not,
      promise: promise || "",
      equals,
      utils: {
        printReceived: inspect,
        printExpected: inspect,
        stringify: inspect,
        RECEIVED_COLOR: inspect,
        EXPECTED_COLOR: inspect,
        matcherHint: (name: string, received = "received", expected = "expected") => `expect(${received}).${name}(${expected})`,
      },
    };
  }

  return { register, result, asymmetric, context };
})
