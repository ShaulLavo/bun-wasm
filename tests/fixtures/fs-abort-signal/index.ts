import fs, { readFileSync, writeFileSync } from "node:fs";

// readFile, writeFile and appendFile reject an aborted signal with Node's AbortError: an
// Error (not the DOMException in signal.reason) named AbortError, code ABORT_ERR, message
// "The operation was aborted" and signal.reason as its cause.
const shape = (error: unknown, reason: unknown) => {
  if (!(error instanceof Error)) return `not an Error: ${String(error)}`;
  const { name, code, message, cause } = error as Error & { code?: unknown };
  return `${name} ${code} "${message}" DOMException=${error instanceof DOMException} cause=${cause === reason}`;
};
const outcome = async (label: string, reason: () => unknown, run: () => Promise<unknown>) => {
  try {
    console.log(label, "resolved", await run());
  } catch (error) {
    console.log(label, shape(error, reason()));
  }
};
writeFileSync("f.txt", "hello");

const pre = AbortSignal.abort();
await outcome("readFile pre-aborted", () => pre.reason, () => fs.promises.readFile("f.txt", { signal: pre }));
const custom = new Error("my reason");
await outcome("readFile custom reason", () => custom, () => fs.promises.readFile("f.txt", { signal: AbortSignal.abort(custom) }));
await outcome("appendFile pre-aborted", () => pre.reason, () => fs.promises.appendFile("a.txt", "data", { signal: pre }));
await outcome("writeFile pre-aborted", () => pre.reason, () => fs.promises.writeFile("w.txt", "data", { signal: pre }));
console.log("pre-aborted writes created files", fs.existsSync("a.txt"), fs.existsSync("w.txt"));

{
  const controller = new AbortController();
  const stop = new Error("stop");
  const pending = fs.promises.readFile("f.txt", { signal: controller.signal });
  controller.abort(stop);
  await outcome("readFile aborted in flight", () => stop, () => pending);
}
{
  const controller = new AbortController();
  const pending = fs.promises.readFile("f.txt", { signal: controller.signal });
  controller.abort();
  await outcome("readFile aborted in flight, default reason", () => controller.signal.reason, () => pending);
}
await outcome("readFile with a live signal", () => undefined, () => fs.promises.readFile("f.txt", { signal: new AbortController().signal, encoding: "utf8" }));
await outcome("readFile with a bad signal", () => undefined, () => fs.promises.readFile("f.txt", { signal: {} as AbortSignal }).catch((error) => {
  throw new Error(`${error.name} ${error.code}`);
}));

// writeFile of an iterable writes each chunk; an abort stops it.
await outcome("iterable pre-aborted", () => pre.reason, () => fs.promises.writeFile("i.txt", (async function* () {
  yield "a";
})(), { signal: pre }));
{
  const controller = new AbortController();
  await outcome("iterable aborted between chunks", () => controller.signal.reason, () => fs.promises.writeFile("j.txt", (async function* () {
    yield "a";
    controller.abort();
    yield "b";
  })(), { signal: controller.signal }));
  console.log("written before the abort", readFileSync("j.txt", "utf8"));
}
await fs.promises.writeFile("k.txt", ["x", Buffer.from("y"), new Uint8Array([122])]);
console.log("array of chunks", readFileSync("k.txt", "utf8"));
await fs.promises.writeFile("k.txt", (function* () {
  yield "hex:";
  yield "6869";
})(), "utf8");
console.log("sync generator", readFileSync("k.txt", "utf8"));
await fs.promises.writeFile("k.txt", (async function* () {
  yield "6869";
})(), { encoding: "hex" });
console.log("hex chunks", readFileSync("k.txt", "utf8"));
for (const flag of ["r+", "rs+", "w", "w+"]) {
  writeFileSync("flag.txt", "0123456789");
  await fs.promises.writeFile("flag.txt", (async function* () {
    yield "ZZ";
  })(), { flag });
  console.log("iterable flag", flag, readFileSync("flag.txt", "utf8"));
}
{
  writeFileSync("handle.txt", "0123456789");
  const handle = await fs.promises.open("handle.txt", "r+");
  await handle.writeFile((async function* () {
    yield "AB";
    yield Buffer.from("CD");
  })());
  await fs.promises.writeFile(handle, ["EF"]);
  await handle.close();
  console.log("FileHandle iterables", readFileSync("handle.txt", "utf8"));
}
await outcome("iterable null chunk", () => undefined, () => fs.promises.writeFile("n.txt", [null]).catch((error) => {
  throw new Error(`${error.name} ${error.code}`);
}));

// The callback forms deliver the same AbortError.
const callbackError = (start: (done: (error: unknown) => void) => void) => new Promise((resolve) => start(resolve));
console.log("callback readFile", shape(await callbackError((done) => fs.readFile("f.txt", { signal: pre }, done)), pre.reason));
console.log("callback writeFile", shape(await callbackError((done) => fs.writeFile("o.txt", "x", { signal: pre }, done)), pre.reason));
console.log("callback appendFile", shape(await callbackError((done) => fs.appendFile("o.txt", "x", { signal: pre }, done)), pre.reason));
console.log("callback readFile live signal", await new Promise((resolve) => fs.readFile("f.txt", { signal: new AbortController().signal, encoding: "utf8" }, (error, text) => resolve(`${error} ${text}`))));
try {
  AbortSignal.any([{} as AbortSignal]);
  console.log("AbortSignal.any bad", "no throw");
} catch (error) {
  const err = error as Error & { code?: string };
  console.log("AbortSignal.any bad", err.name, err.code);
}
performance.clearResourceTimings();
performance.setResourceTimingBufferSize(100);
console.log("performance resource timing", typeof performance.clearResourceTimings, typeof performance.setResourceTimingBufferSize);
