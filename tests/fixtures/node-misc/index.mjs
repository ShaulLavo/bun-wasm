import os from "node:os";
import { StringDecoder } from "string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import * as childProcess from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import qs from "node:querystring";
import { EOL } from "os";
import util from "node:util";
import process2 from "node:process";

console.log("os:", os.EOL === "\n", EOL === "\n", typeof os.cpus().length, os.endianness(), typeof os.tmpdir(), os.platform());
const dec = new StringDecoder("utf8");
const euro = Buffer.from("€");
console.log("string_decoder:", dec.write(euro.subarray(0, 1)) + dec.write(euro.subarray(1)) + dec.end());
console.log("timers/promises:", await sleep(2, "slept"));
console.log("querystring:", qs.stringify({ a: [1, 2], b: "x y" }), JSON.stringify(qs.parse("a=1&a=2&b=x%20y")));
console.log("net.isIP:", net.isIP("127.0.0.1"), net.isIP("::1"), net.isIP("nope"));
console.log("process module:", process2 === process);
console.log("util default:", typeof util.inspect);
for (const [name, fn] of [
  ["child_process.spawn", () => childProcess.spawn("ls")],
  ["http.createServer", () => createServer()],
  ["net.connect", () => net.connect(80)],
]) {
  try {
    fn();
    console.log(name, "works");
  } catch (err) {
    console.log(name, "throws:", err instanceof Error);
  }
}

// Things WASI can't do: they fail loudly instead of hanging or lying.
console.log("Bun.which:", Bun.which("ls"));
for (const name of ["spawn", "spawnSync", "serve"]) {
  try {
    Bun[name]({ cmd: ["ls"], fetch() {} });
    console.log(`Bun.${name} ran`);
  } catch (err) {
    console.log(`Bun.${name} throws:`, err.message.includes("not supported in bun-wasm"));
  }
}
try {
  await fetch("https://example.com/");
  console.log("fetch resolved");
} catch (err) {
  console.log("fetch rejects:", err instanceof TypeError);
}
console.log("fetch file: URL:", await (await fetch(import.meta.url)).text().then((t) => t.startsWith("import os")));
