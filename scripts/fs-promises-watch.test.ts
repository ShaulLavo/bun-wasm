import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

test("the exact shim import links through the production ESM wrapper", () => {
  const { promises } = filesystem();
  const program = `import { SourceTextModule } from "node:vm";
    import { readFileSync } from "node:fs";
    const target = new SourceTextModule(readFileSync(0, "utf8"));
    const importer = new SourceTextModule('import { watch } from "fs/promises";');
    await importer.link(() => target);
    console.log("linked");`;
  const output = execFileSync("node", ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", program], {
    input: wrapperSource(promises), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  expect(output.trim()).toBe("linked");
});
