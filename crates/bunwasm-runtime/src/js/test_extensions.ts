(function (internal: {
  require(name: "inspect"): { bunInspect(value: unknown): string };
  require(name: "test_matchers"): {
    settle<T, U>(value: T | Promise<T>, consume: (value: T) => U): U | Promise<U>;
  };
}) {
  type Matcher = (...args: unknown[]) => unknown;
  const inspect = internal.require("inspect").bunInspect;
  const { settle } = internal.require("test_matchers");

  function register(matchers: object, define: (name: string, matcher: Matcher) => void) {
    const seen = new Set<string>();
    let owner = matchers;
    while (owner && owner !== Object.prototype && owner !== Function.prototype) {
      for (const name of Object.getOwnPropertyNames(owner)) {
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

  function failure(name: string, result: unknown, not: boolean) {
    if (result === null || typeof result !== "object" || !("pass" in result) || result.pass === undefined) {
      throw new Error(`Unexpected return from matcher function \`${name}\`.\nMatcher functions should return an object in the following format:\n  {message?: string | function, pass: boolean}\n'${inspect(result)}' was returned`);
    }
    if (!!result.pass !== not) return null;
    const message = "message" in result ? result.message : undefined;
    const value: unknown = typeof message === "function" ? message.call(result) : message;
    return { raw: true, body: value === undefined ? "No message was specified for this matcher." : String(value) };
  }

  function result(name: string, value: unknown, not: boolean) {
    return settle(value, settled => failure(name, settled, not));
  }

  function context(not: boolean, promise: string | undefined, equals: (a: unknown, b: unknown) => boolean) {
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

  return { register, result, context };
})
