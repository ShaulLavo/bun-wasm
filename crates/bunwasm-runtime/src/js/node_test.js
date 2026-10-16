(function (internal) {
  "use strict";
  const runner = internal.require("bun_test").exports;
  function register(kind, name, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    options ||= {};
    const run = options.skip ? runner.test.skip : options.todo ? runner.test.todo : kind;
    return run(name, callback && (() => callback()), options.timeout);
  }
  const test = (name, options, callback) => register(runner.test, name, options, callback);
  test.test = test;
  test.it = test;
  test.suite = test.describe = runner.describe;
  test.skip = (name, options, callback) => register(runner.test.skip, name, options, callback);
  test.todo = (name, options, callback) => register(runner.test.todo, name, options, callback);
  test.only = (name, options, callback) => register(runner.test.only, name, options, callback);
  test.before = runner.beforeAll;
  test.after = runner.afterAll;
  test.beforeEach = runner.beforeEach;
  test.afterEach = runner.afterEach;
  return test;
})
