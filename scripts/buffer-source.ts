import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export function loadBufferSource() {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-buffer-source-"));
  try {
    const modules = new Map();
    const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
    for (const file of readdirSync(directory).filter(file => /^buffer_[a-z_]+\.ts$/.test(file))) {
      const name = file.slice(0, -3);
      const output = join(scratch, `${name}.js`);
      const result = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
        new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url).pathname, output]);
      if (result.exitCode !== 0) throw new Error(`Failed to emit ${name}: ${result.stderr.toString()}`);
      modules.set(name, runInNewContext(readFileSync(output, "utf8"), { structuredClone })());
    }
    const require = (name: string) => {
      if (!modules.has(name)) throw new Error(`Unexpected Buffer dependency ${name}`);
      return modules.get(name);
    };
    const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/buffer.js", import.meta.url), "utf8");
    return runInNewContext(source, { TextEncoder, TextDecoder })({ require });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
