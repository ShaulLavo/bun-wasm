import { test } from "bun:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

const worker = String.raw`
const { parentPort, receiveMessageOnPort } = require("node:worker_threads");
parentPort.on("message", ({ port, gate, capable }) => {
  const rounds = [];
  for (let round = 1; round <= 2; round++) {
    parentPort.postMessage({ ready: round });
    const waited = Atomics.wait(gate, 0, round - 1);
    const first = receiveMessageOnPort(port)?.message;
    const body = receiveMessageOnPort(port)?.message;
    const after = capable ? receiveMessageOnPort(port)?.message : body;
    const empty = receiveMessageOnPort(port) === undefined;
    if (capable && (body.text !== "λ".repeat(600000) || Array.from(new Uint8Array(body.buffer)).join() !== "2,3,5,7")) throw Error("Body differs");
    if (capable) body.port.postMessage("reply" + round);
    rounds.push({ waited, first, after, empty, text: capable ? body.text.length : null });
  }
  port.close(); parentPort.postMessage({ rounds });
});
`;
const main = String.raw`
const { Worker, MessageChannel } = require("node:worker_threads"), fs = require("node:fs");
const [out, capableText] = process.argv.slice(2), capable = capableText === "true";
const child = new Worker("/home/user/overflow-worker.cjs"), channel = new MessageChannel(), gate = new Int32Array(new SharedArrayBuffer(4));
const replies = [], sends = [], owned = [];
const deadline = setTimeout(() => { fs.writeFileSync(out, JSON.stringify({ timeout: true })); child.terminate(); }, 20000);
let received;
async function finish() {
  if (!received || capable && replies.length !== 2) return;
  clearTimeout(deadline);
  fs.writeFileSync(out, JSON.stringify({ sends, replies, received }));
  channel.port1.close(); for (const port of owned) port.close(); await child.terminate();
}
child.on("message", value => {
  if (!value.ready) { received = value.rounds; finish(); return; }
  const round = value.ready, carried = new MessageChannel(), buffer = new Uint8Array([2,3,5,7]).buffer;
  owned.push(carried.port1, carried.port2);
  carried.port1.on("message", reply => { replies.push(reply); finish(); });
  channel.port1.postMessage("before");
  let rejection = null;
  try { channel.port1.postMessage({ text: "λ".repeat(600000), buffer, port: carried.port2 }, [buffer, carried.port2]); }
  catch (error) { rejection = { name: error.name, message: error.message }; }
  if (capable && rejection || !capable && (!rejection || buffer.byteLength !== 4)) throw Error("Admission differs");
  const busy = new ArrayBuffer(8), busyPort = new MessageChannel(); owned.push(busyPort.port1, busyPort.port2);
  let busyRejected = false;
  try { channel.port1.postMessage({ text: "x".repeat(1100000), buffer: busy, port: busyPort.port2 }, [busy, busyPort.port2]); }
  catch (error) { busyRejected = error.name === "DataCloneError" && (capable ? error.message.includes("busy") : error.message.includes("unavailable")); }
  if (!busyRejected || busy.byteLength !== 8) throw Error("Second large message was not rejected atomically");
  busyPort.port2.postMessage("still owned");
  const usable = require("node:worker_threads").receiveMessageOnPort(busyPort.port1)?.message === "still owned";
  if (!usable) throw Error("Rejected port moved");
  sends.push({ round, bytesAfter: buffer.byteLength, busyRejected, usable, rejection: rejection?.name ?? null });
  channel.port1.postMessage("after"); Atomics.store(gate, 0, round); Atomics.notify(gate, 0);
});
child.postMessage({ port: channel.port2, gate, capable }, [channel.port2]);
`;

async function exercise(name: "chromium" | "webkit", inlineOnly: boolean, site: string) {
  const task = session("bun-wasm-large-message-");
  const previous = process.env.ROOT;
  process.env.ROOT = join(site, "site");
  try {
    const browser = await task.launch(name === "chromium" ? chromium : webkit);
    const context = await browser.newContext();
    if (inlineOnly) await context.addInitScript(() => {
      const Native = SharedArrayBuffer;
      globalThis.SharedArrayBuffer = new Proxy(Native, { construct(target, args, constructor) {
        if (args[0] === 0 && args[1]?.maxByteLength === 67108864) throw new RangeError("Private overflow allocation unavailable");
        return Reflect.construct(target, args, constructor);
      } });
    });
    const page = await context.newPage(), url = await task.serve();
    await page.goto(`${url}?engine=browser&prompt=off&mode=memory`);
    assert.match(await ready(page), /ready/);
    const capable = await page.evaluate(() => {
      try { return new SharedArrayBuffer(0, { maxByteLength: 67108864 }).growable === true; } catch { return false; }
    });
    if (inlineOnly) assert.equal(capable, false);
    await writeFile(page, "/home/user/overflow-worker.cjs", worker);
    await writeFile(page, "/home/user/overflow-main.cjs", main);
    const result = await run(page, `bun /home/user/overflow-main.cjs /home/user/overflow-out.json ${capable}`, 30000);
    assert.equal(result.code, 0, result.output);
    const body = await page.evaluate(async () => {
      const fs = Reflect.get(Reflect.get(globalThis, "playground"), "fs"), read = Reflect.get(fs, "readFile");
      if (typeof read !== "function") throw new Error("Missing playground file reader");
      const bytes: unknown = await Reflect.apply(read, fs, ["/home/user/overflow-out.json"]);
      if (!(bytes instanceof Uint8Array)) throw new Error("Invalid playground file bytes");
      return new TextDecoder().decode(bytes);
    });
    const observed = JSON.parse(body);
    console.log(`${name} ${inlineOnly ? "forced-inline-only" : "native-capability"}: ${JSON.stringify({ capable, observed })}`);
    assert.deepEqual(observed.received, [1, 2].map(() => ({ waited: "ok", first: "before", after: "after", empty: true, text: capable ? 600000 : null })));
    assert.deepEqual(observed.replies, capable ? ["reply1", "reply2"] : []);
    assert.deepEqual(observed.sends, [1, 2].map(round => ({ round, bytesAfter: capable ? 0 : 4, busyRejected: true, usable: true, rejection: capable ? null : "DataCloneError" })));
    return capable;
  } finally { await task.cleanup(); process.env.ROOT = previous; }
}

for (const name of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${name}: production guest overflow and explicit inline-only host contract`, async () => {
    assert.ok(name === "chromium" || name === "webkit");
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    assert.ok(provided, "Supply the shared same-commit Browser guest-site producer through BUN_WASM_BROWSER_SITE");
    const site = resolve(provided);
    verifySite(site);
    const capable = await exercise(name, false, site);
    await exercise(name, true, site);
    if (name === "chromium") assert.equal(capable, true, "A capable host is required for the large-message success gate");
    verifySite(site);
  }, 180000);
}
