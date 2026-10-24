(function (internal: BunWasm.Internal) {
  "use strict";
  type Options = { skip?: unknown; todo?: unknown; timeout?: number } | null;
  type Callback = () => unknown;
  type RegistrationArgs = [name: string, options?: Options | Callback, callback?: Callback]
    | [callback: Callback, options?: Options]
    | [options: Options, callback?: Callback];
  const runner = internal.require("bun_test").exports;
  function register(kind: BunWasm.TestRegistrar, ...[name, options, callback]: RegistrationArgs) {
    if (typeof name === "function") {
      callback = name;
      name = callback.name || "<anonymous>";
    } else if (typeof name !== "string") {
      callback = typeof options === "function" ? options : undefined;
      options = name;
      name = callback?.name || "<anonymous>";
    }
    if (typeof options === "function") { callback = options; options = {}; }
    options ||= {};
    const run = options.skip ? runner.test.skip : options.todo ? runner.test.todo : kind;
    return run(name, callback && (() => callback()), options.timeout);
  }
  const test = (...args: RegistrationArgs) => register(runner.test, ...args);
  test.test = test;
  test.it = test;
  test.suite = test.describe = runner.describe;
  test.skip = (...args: RegistrationArgs) => register(runner.test.skip, ...args);
  test.todo = (...args: RegistrationArgs) => register(runner.test.todo, ...args);
  test.only = (...args: RegistrationArgs) => register(runner.test.only, ...args);
  test.before = runner.beforeAll;
  test.after = runner.afterAll;
  test.beforeEach = runner.beforeEach;
  test.afterEach = runner.afterEach;
  return test;
})
