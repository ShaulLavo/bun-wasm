import { expect, test } from "bun:test";
import { assertShellConsumerResult } from "./safari-shell";

const names = ["lookup", "files-cwd-env-exit9", "epipe", "nested-stdin", "live-ticker", "binary", "interrupt", "preview"];
function result() { return { results: names.map(name => ({ name, ok: true })) }; }
test("Safari consumer requires every original shell and Bun outcome", () => {
  expect(assertShellConsumerResult(result())).toEqual(result());
  expect(() => assertShellConsumerResult({ results: [] })).toThrow();
  const missing = result(); missing.results.pop();
  expect(() => assertShellConsumerResult(missing)).toThrow();
  const failed = result(); failed.results[0]!.ok = false;
  expect(() => assertShellConsumerResult(failed)).toThrow();
  const renamed = result(); renamed.results[0]!.name = "substitute";
  expect(() => assertShellConsumerResult(renamed)).toThrow();
});
