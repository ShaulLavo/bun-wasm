import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { checkEmptyPaths } from "../tests/fixtures/fs-empty-path/index.ts";

// Run the shipped path adapter over real host filesystem calls. The test creates
// only a mkdtemp directory, which the shared regression fixture removes.
async function checkSource(): Promise<void> {
  const source = fs.readFileSync(new URL("../crates/bunwasm-runtime/src/js/node_fs.js", import.meta.url), "utf8");
  const optionsPath = process.argv[2];
  if (!optionsPath) throw new Error("Missing generated filesystem options factory");
  const helpers = runInNewContext(fs.readFileSync(optionsPath, "utf8"), { Date })({});
  const native = {
    hostCaps: { proc_spawn: false },
    utf8Decode: (bytes: Uint8Array) => Buffer.from(bytes).toString(),
    stat(file: string, link: boolean, bigint = false) { return link ? fs.lstatSync(file, { bigint }) : fs.statSync(file, { bigint }); },
    exists: fs.existsSync,
    readFile: fs.readFileSync,
    readdir: fs.readdirSync,
    open: fs.openSync,
    readlink: fs.readlinkSync,
    mkdir: (file: string, recursive: boolean) => fs.mkdirSync(file, { recursive }),
    rm: (file: string, recursive: boolean, force: boolean) => fs.rmSync(file, { recursive, force }),
    rmdir: (file: string) => fs.rmdirSync(file),
    realpath: fs.realpathSync,
    randomBytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
  };
  const factory = runInNewContext(source, { Uint8Array, ArrayBuffer, URL, Date, FinalizationRegistry });
  const module = factory({ native, describe: String, realTimers: { setImmediate },
    require(name: string) {
      if (name === "buffer") return { Buffer };
      if (name === "path") return path;
      if (name === "fs_options") return helpers;
      if (name === "fs_watch") return () => ({});
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  await checkEmptyPaths(module.fs);
}

await checkSource();
