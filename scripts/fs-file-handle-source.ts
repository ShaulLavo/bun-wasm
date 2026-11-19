import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The shipped fs/promises FileHandle module for harnesses that evaluate node_fs.js with a
// stub loader. Its only runtime dependency is node:events; streams load on first use.
export function loadFileHandleModule(): unknown {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/fs_file_handle.ts", import.meta.url), "utf8");
  const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__factory = ${source}`), { TextEncoder, DOMException });
  return factory({
    describe: String,
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "streams") return { ReadableStream };
      throw new Error(`Unexpected FileHandle dependency ${name}`);
    },
  });
}
