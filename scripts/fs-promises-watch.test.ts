import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
function filesystem() {
  const factory = runInNewContext(readFileSync(new URL("node_fs.js", directory), "utf8"), { URL, Uint8Array, ArrayBuffer });
  return factory({ native: {}, require: () => () => ({}) });
}

test("fs/promises exposes the watch imported by the Deno shim", () => {
  const { fs, promises } = filesystem();
  expect(typeof promises.watch).toBe("function");
  expect(fs.promises.watch).toBe(promises.watch);
});

function wrapperSource(value: object): string {
  const source = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
  const factory = runInNewContext(source.slice(source.indexOf("function wrapperSource(")) + "\nwrapperSource");
  return factory("node:fs/promises", value);
}

test("the exact shim import links through the production ESM wrapper", async () => {
  const { promises } = filesystem();
  const before = Object.getOwnPropertyDescriptor(globalThis, "__bunwasm_wrap");
  Object.defineProperty(globalThis, "__bunwasm_wrap", { configurable: true, value: () => ({ value: promises, default: promises }) });
  try {
    const target = `data:text/javascript,${encodeURIComponent(wrapperSource(promises))}`;
    const source = `import { watch } from ${JSON.stringify(target)}; export default typeof watch;`;
    expect((await import(`data:text/javascript,${encodeURIComponent(source)}`)).default).toBe("function");
  } finally {
    if (before) Object.defineProperty(globalThis, "__bunwasm_wrap", before);
    else Reflect.deleteProperty(globalThis, "__bunwasm_wrap");
  }
});
