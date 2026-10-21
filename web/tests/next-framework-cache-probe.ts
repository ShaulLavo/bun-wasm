import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, unlinkSync } from "node:fs";

const require = createRequire(import.meta.url);
const fs: unknown = require("node:fs");
assert.ok(fs && typeof fs === "object");
const webpack: unknown = require("next/dist/compiled/webpack/webpack");
assert.ok(webpack && typeof webpack === "object" && "init" in webpack && typeof webpack.init === "function");
webpack.init();
assert.ok("NodeEnvironmentPlugin" in webpack && typeof webpack.NodeEnvironmentPlugin === "function");
const plugin: unknown = Reflect.construct(webpack.NodeEnvironmentPlugin, [{ infrastructureLogging: { level: "none", stream: process.stderr } }]);
assert.ok(plugin && typeof plugin === "object" && "apply" in plugin && typeof plugin.apply === "function");
const compiler = { hooks: { beforeRun: { tap() {} } } };
plugin.apply(compiler);
assert.ok("intermediateFileSystem" in compiler);
const intermediate = compiler.intermediateFileSystem;
assert.ok(intermediate && typeof intermediate === "object");
process.stdout.write(JSON.stringify({ WriteStream: typeof Reflect.get(fs, "WriteStream"), ReadStream: typeof Reflect.get(fs, "ReadStream") }) + "\n");

async function probe(filesystem: object, method: string, path: string) {
  const factory: unknown = Reflect.get(filesystem, method);
  assert.equal(typeof factory, "function");
  try {
    assert.ok(typeof factory === "function");
    const stream: unknown = factory.call(filesystem, path);
    assert.ok(stream && typeof stream === "object" && "once" in stream && typeof stream.once === "function");
    assert.ok("destroy" in stream && typeof stream.destroy === "function");
    const once = stream.once;
    const closed = new Promise<void>(resolve => { once.call(stream, "close", resolve); });
    stream.destroy();
    await closed;
    process.stdout.write(`${method}: constructed and closed\n`);
  } catch (error) {
    process.stderr.write(`${method}: ${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

const output = "/home/user/webpack-cache-constructor-probe";
try {
  await probe(intermediate, "createWriteStream", output);
  await probe(intermediate, "createReadStream", "/home/user/package.json");
} finally { if (existsSync(output)) unlinkSync(output); }
