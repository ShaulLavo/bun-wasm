import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";

const require = createRequire(import.meta.url);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function factory(name: string) {
  const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}`, import.meta.url), "utf8");
  const emitted = new Bun.Transpiler({ loader: name.endsWith(".ts") ? "ts" : "js" }).transformSync(`globalThis.factory = ${source}`);
  return runInThisContext(emitted + ";globalThis.factory");
}

function fixture() {
  const chunks: (Uint8Array | number)[] = [];
  const closes: number[] = [];
  let netLoaded = false;
  const internal = {
    native: { hostCaps: {}, isatty: () => false, wake() {},
      procRead: () => chunks.shift() ?? -6, procClose(fd: number) { closes.push(fd); return 0; } },
    web: { Request, Response, Headers }, ioPending: () => 0, pumpIo: () => false,
    concatBytes: (bytes: Uint8Array[]) => Buffer.concat(bytes),
    builtin(name: string): unknown { return name === "node:stream" ? core.Stream : require(name); },
    require(name: string): unknown {
      if (name === "buffer") return { Buffer };
      if (name === "http_common") return {};
      if (name === "websocket") return { clientClass: () => class {} };
      if (name !== "net") throw new Error(`unexpected ${name}`);
      if (!netLoaded) { netLoaded = true; factory("net.js")(internal); }
      return {};
    },
  };
  const core = factory("node_stream_core.js")(internal);
  const stdin = factory("process_stdin.ts")(internal)();
  return { stdin, internal, chunks, closes };
}

test("pause releases empty-open-pipe keepalive without close; resume retains input and explicit unref", async () => {
  const f = fixture();
  const seen: string[] = [];
  f.stdin.on("data", (chunk: Uint8Array) => seen.push(String(chunk)));
  await tick(); f.internal.pumpIo();
  expect(f.internal.ioPending()).toBe(1);
  f.stdin.pause();
  await tick(); f.internal.pumpIo();
  expect(f.internal.ioPending()).toBe(0);
  expect(f.closes).toEqual([]);
  f.stdin.ref();
  expect(f.internal.ioPending()).toBe(0);
  f.chunks.push(Buffer.from("later"));
  f.stdin.resume();
  await tick(); f.internal.pumpIo(); await tick();
  expect(seen).toEqual(["later"]);
  expect(f.internal.ioPending()).toBe(1);
  f.stdin.unref().pause().resume();
  await tick(); f.internal.pumpIo();
  expect(f.internal.ioPending()).toBe(0);
  f.stdin.ref();
  expect(f.internal.ioPending()).toBe(1);
  f.stdin.destroy(); f.internal.pumpIo(); await tick();
  expect(f.internal.ioPending()).toBe(0);
  expect(f.closes).toEqual([0]);
});

for (const executable of ["node", process.execPath]) {
  test(`${executable} exits after pause then ref with the parent write endpoint open`, async () => {
    const source = 'process.stdin.on("data", () => {}); setTimeout(() => { process.stdin.pause(); process.stdin.ref(); console.log("PAUSED"); }, 20);';
    const child = Bun.spawn([executable, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let expired = false;
    const deadline = setTimeout(() => { expired = true; child.kill(); }, 750);
    try {
      expect(await child.exited).toBe(0);
      expect(expired).toBe(false);
      expect(await new Response(child.stdout).text()).toBe("PAUSED\n");
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.stdin.end();
      await child.exited;
    }
  });
}
