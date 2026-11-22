// Node 26 stream semantics Bun ships, from upstream test/js/node/stream/node-stream.test.js.
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Duplex, finished, getDefaultHighWaterMark, PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const tick = () => new Promise(resolve => setImmediate(resolve));
const errorCode = (run: () => unknown) => {
  try { run(); return "no error"; } catch (error) { return `${(error as { code?: string }).code}: ${(error as Error).message}`; }
};
const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });

console.log("default highWaterMark", getDefaultHighWaterMark(false), new Readable().readableHighWaterMark, new Writable().writableHighWaterMark);

const chunks = new Readable({ read() {} });
chunks.push(Buffer.from("abc"));
chunks.push(Buffer.from("de"));
chunks.push(null);
await tick();
console.log("read() per chunk", String(chunks.read()), String(chunks.read()), chunks.read());

const decoded = new Readable({ read() {} });
decoded.setEncoding("utf8");
decoded.push("abc");
decoded.push("de");
decoded.push(null);
await tick();
console.log("read() with a decoder", decoded.read());

const destroyed = new Readable({ read() {} });
destroyed.resume();
destroyed.destroy();
console.log("pause() after destroy", destroyed.pause() === destroyed, destroyed.readableFlowing, destroyed.isPaused());

let reads = 0;
const inFlight = new Readable({ highWaterMark: 1024, read() { reads++; } });
inFlight.read(10);
inFlight.unshift("x");
process.nextTick(() => inFlight.push(null));
inFlight.push("y");
await tick();
console.log("reads while one is in flight", reads);

for (const options of [{ decodeStrings: false }, {}]) {
  const writable = new Writable({ ...options, write(_chunk, _encoding, callback) { callback(); } });
  console.log("write(string, 'buffer')", errorCode(() => writable.write("hi", "buffer")));
}

const disposed = sink();
const disposedError = new Promise<Error & { code?: string }>(resolve => disposed.once("error", resolve));
await disposed[Symbol.asyncDispose]();
const abort = await disposedError;
console.log("Writable asyncDispose", abort.name, abort.code, abort.message);

const composed = Readable.from(["a"]).compose(new Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } }));
console.log("compose result", composed instanceof Duplex, Object.hasOwn(Readable.prototype, "compose"));
const nonWritable = errorCode(() => Readable.from(["a"]).compose(new Readable({ read() {} })));
console.log("compose non-writable", nonWritable.split(":")[0], nonWritable.includes("The argument 'streams[1]' must be writable."));
console.log("map(123)", errorCode(() => Readable.from([1]).map(123 as never)));
const reduced = await Readable.from([1]).reduce(123 as never).then(() => "resolved", (error: Error) => error.message);
console.log("reduce(123)", reduced);

const source = new Readable({ read() {} });
const target = sink();
const pair = Duplex.from({ readable: source, writable: target });
const targetError = new Promise(resolve => target.on("error", resolve));
const pairError = new Promise(resolve => pair.on("error", resolve));
const boom = new Error("boom");
source.destroy(boom);
console.log("Duplex.from readable error", (await targetError) === boom, (await pairError) === boom, target.destroyed);

const piped = new PassThrough();
const pipedSink = sink();
const unpiped = new Promise(resolve => pipedSink.on("unpipe", resolve));
piped.pipe(pipedSink);
piped.end("x");
await unpiped;
console.log("autoDestroyed piped source", piped.readableFlowing, piped.isPaused(), piped.destroyed);

const ended = Readable.from([Buffer.from("a"), Buffer.from("b")], { objectMode: false });
const reader = Readable.toWeb(ended).getReader();
while (!(await reader.read()).done);
await new Promise(resolve => (ended.closed ? resolve(undefined) : ended.once("close", resolve)));
console.log("toWeb source after EOF", ended.readableFlowing, ended.isPaused());

const webChunks: Uint8Array[] = [];
const webWritable = Writable.fromWeb(new WritableStream({ write(chunk) { webChunks.push(chunk); } }));
await new Promise<void>((resolve, reject) => webWritable._write("68656c6c6f", "hex", (error?: Error | null) => (error ? reject(error) : resolve())));
console.log("fromWeb hex chunk", webChunks[0]?.constructor.name, Buffer.from(webChunks[0]!).toString());

const pausedWeb = Readable.fromWeb(new Blob([Buffer.alloc(16484, "x")]).stream());
let pausedBytes = 0;
pausedWeb.on("data", chunk => { pausedBytes += chunk.length; pausedWeb.destroy(); });
pausedWeb.pause();
const pausedClosed = new Promise(resolve => pausedWeb.once("close", resolve));
pausedWeb.read(0);
while (!pausedWeb.readableEnded && !(pausedWeb as unknown as { _readableState: { ended: boolean } })._readableState.ended) await tick();
pausedWeb.resume();
await pausedClosed;
console.log("fromWeb bytes after destroy", pausedBytes);

for (const size of [0x10, 0xffff, 0x10000, 0x20010]) {
  const path = `${import.meta.dir}/readable-${size}.bin`;
  writeFileSync(path, new Uint8Array(size));
  const stream = createReadStream(path);
  const events: string[] = [];
  const closed = new Promise(resolve => stream.on("close", resolve));
  stream.on("readable", () => {
    const data = stream.read();
    events.push(data === null ? "null" : "data");
  });
  await closed;
  console.log("createReadStream readable", size, events.at(-1), events.filter(event => event === "null").length);
}

let objEncoding: unknown = "unset";
const objWritable = new Writable({
  objectMode: true,
  write(_chunk, encoding, callback) {
    objEncoding = encoding;
    callback();
  },
});
const objDone = new Promise<void>(resolve => objWritable.once("finish", resolve));
objWritable.end(new Uint8Array([1, 2, 3]));
await objDone;
console.log("objectMode Uint8Array encoding", String(objEncoding));

const als = new AsyncLocalStorage<string>();
const finishedOutsideAls = new Readable({ read() {} });
let outsideObserved: string | undefined = "unset";
const finishedDone = new Promise<void>(resolve => {
  finished(finishedOutsideAls, () => {
    outsideObserved = als.getStore();
    resolve();
  });
});
als.run("emit-ctx", () => {
  finishedOutsideAls.push(null);
  finishedOutsideAls.resume();
});
await finishedDone;
const finishedInsideAls = new Readable({ read() {} });
let insideObserved: string | undefined = "unset";
const finishedInsideDone = new Promise<void>(resolve => {
  als.run("reg-ctx", () => {
    finished(finishedInsideAls, () => {
      insideObserved = als.getStore();
      resolve();
    });
  });
});
als.run("other-ctx", () => {
  finishedInsideAls.push(null);
  finishedInsideAls.resume();
});
await finishedInsideDone;
console.log("finished ALS", outsideObserved, insideObserved);

const abortCtrl = new AbortController();
const destroyBoom = new Error("destroy boom");
const srcAbort = new Readable({
  read() {},
  destroy(_err, cb) {
    cb(destroyBoom);
  },
});
const dstAbort = sink();
const pipelinePromise = pipeline(srcAbort, dstAbort, { signal: abortCtrl.signal });
abortCtrl.abort();
const pipelineErr = await pipelinePromise.then(() => null, (err: Error) => err);
console.log("pipeline destroy overrides abort", pipelineErr === destroyBoom, pipelineErr?.message);

const composedAbortCtrl = new AbortController();
const composedAbort = Readable.from(async function* () {
  await new Promise(resolve => setTimeout(resolve, 100));
  yield "x";
}()).compose(new PassThrough());
const composedAbortPromise = pipeline(composedAbort, sink(), { signal: composedAbortCtrl.signal });
composedAbortCtrl.abort();
const composedAbortErr = await composedAbortPromise.then(() => null, (err: Error) => err);
console.log("pipeline compose abort kept", composedAbortErr?.name, (composedAbortErr as Error & { code?: string })?.code);

const req = createRequire(import.meta.url);
console.log("stream/iter gated", Array.isArray(req.resolve.paths("stream/iter")));
console.log("resolve.paths(null)", errorCode(() => req.resolve.paths(null as never)));

let startThisSame = false;
let pullThisSame = false;
const plainSource = {
  start(controller: ReadableStreamDefaultController<string>) {
    startThisSame = this === plainSource;
    controller.enqueue("ok");
  },
  pull(controller: ReadableStreamDefaultController<string>) {
    pullThisSame = this === plainSource;
    controller.close();
  },
};
const plainText = await new Response(new ReadableStream(plainSource)).text();
console.log("ordinary ReadableStream this", plainText, startThisSame, pullThisSame);

const directStream = new ReadableStream({
  type: "direct" as never,
  pull(controller: { write(chunk: string): void; close(): void }) {
    controller.write("direct-ok");
    controller.close();
  },
} as never);
console.log("direct stream", await new Response(directStream).text());

const iterProbe = `${import.meta.dir}/stream-iter-probe.mjs`;
writeFileSync(
  iterProbe,
  `import { createRequire, builtinModules, isBuiltin } from "node:module";
import { Readable } from "node:stream";
const req = createRequire(import.meta.url);
const paths = req.resolve.paths("stream/iter");
const nodePaths = req.resolve.paths("node:stream/iter");
let reqOk = false;
try { req("stream/iter"); reqOk = true; } catch {}
let impOk = false;
try { await import("stream/iter"); impOk = true; } catch {}
console.log(JSON.stringify({
  pathsNull: paths === null,
  nodePathsNull: nodePaths === null,
  isBuiltinBare: isBuiltin("stream/iter"),
  isBuiltinNode: isBuiltin("node:stream/iter"),
  inBuiltinModules: builtinModules.includes("stream/iter"),
  reqOk,
  impOk,
}));
`,
);
const iterStaticProbe = `${import.meta.dir}/stream-iter-static.mjs`;
writeFileSync(
  iterStaticProbe,
  `import { fromReadable } from "node:stream/iter";
import { Readable } from "node:stream";
let destroyErr = null;
const r = new Readable({
  read() { this.push("chunk"); },
  destroy(err, cb) { destroyErr = err; cb(null); },
});
for await (const _ of fromReadable(r)) {
  break;
}
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({
  name: destroyErr?.name ?? null,
  code: destroyErr?.code ?? null,
}));
`,
);
const runChild = (args: string[]) => {
  const out = Bun.spawnSync([process.execPath, ...args]);
  if (out.exitCode !== 0) throw new Error(`child failed (${args.join(" ")}): ${out.stderr.toString()}`);
  return out.stdout.toString().trim();
};
console.log("stream/iter enabled", runChild(["--experimental-stream-iter", iterProbe]));
console.log("stream/iter static break", runChild(["--experimental-stream-iter", iterStaticProbe]));
console.log("stream/iter condition value", runChild(["--conditions", "--experimental-stream-iter", iterProbe]));
console.log("stream/iter script arg", runChild([iterProbe, "--experimental-stream-iter"]));
