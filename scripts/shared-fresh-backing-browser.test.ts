// Browser-guest check: a real Browser-engine guest, on the production playground site built from
// this checkout's guest, runs the original post-before-notify order: the sender posts, then
// notifies a gate the receiver is blocked on, with no event-loop turn in the receiver.
// Inside the supported domain the first receive returns the message; outside it the same receive
// fails by name, the frame stays whole, and a later turn delivers it. Every case asserts the
// process's natural exit status.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

const notAttached = "ERR_WORKER_MESSAGE_BACKING_NOT_ATTACHED";
type Pool = { created: boolean; classes: number[]; lanes: number };
interface PlaygroundHook { readonly playground: { fs: { readFile(path: string): Promise<Uint8Array> }; sharedObjects: { inspectPool(): Pool } } }
interface Case { readonly main: string; readonly expect: Record<string, unknown>; }

// Guest programs. The receiver blocks with no message handler running, then receives exactly once.
const worker = String.raw`
const { parentPort, receiveMessageOnPort } = require("node:worker_threads");
function attempt(port) { try { return { message: receiveMessageOnPort(port)?.message }; } catch (error) { return { thrown: error.code }; } }
function describe(value) {
  const signal = value?.signal;
  return { signal: signal?.byteLength, shared: signal instanceof SharedArrayBuffer, v: value?.v };
}
parentPort.on("message", ({ port, gate, mode, forward }) => {
  if (mode === "forward") { port.on("message", value => { forward.postMessage(value); Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }); port.ref(); parentPort.postMessage({ ready: true }); return; }
  parentPort.postMessage({ ready: true });
  if (mode === "sendFresh") {
    Atomics.wait(gate, 1, 0);
    forward.postMessage({ signal: new SharedArrayBuffer(4) });
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    return;
  }
  if (mode === "loop") {
    let seen = 0, count = 0, bytes = 0, thrown = null;
    for (let round = 0; round < 8; round++) {
      while (Atomics.load(gate, 0) === seen) Atomics.wait(gate, 0, seen);
      seen = Atomics.load(gate, 0);
      const got = attempt(port);
      if (got.thrown) { thrown = got.thrown; break; }
      count++; bytes += got.message.signal.byteLength;
      Atomics.store(gate, 1, count); Atomics.notify(gate, 1);
    }
    parentPort.postMessage({ result: { count, bytes, thrown } });
    return;
  }
  Atomics.wait(gate, 0, 0);
  const first = attempt(port);
  if (first.thrown) {
    // A later turn delivers the same frame, whole, including any port it carried.
    setTimeout(() => {
      const later = attempt(port);
      const inner = later.message?.inner;
      if (inner) inner.postMessage({ v: "viaPort" });
      const result = { first: first.thrown, later: later.thrown ?? describe(later.message) };
      parentPort.postMessage({ result: inner ? { ...result, hasPort: true } : result });
    }, 30);
    return;
  }
  const inner = first.message?.inner;
  if (mode === "reply") {
    Atomics.wait(gate, 1, 0);
    const reply = attempt(inner);
    parentPort.postMessage({ result: { first: describe(first.message), reply: reply.thrown ?? describe(reply.message) } });
    return;
  }
  parentPort.postMessage({ result: { first: describe(first.message) } });
});
`;
const prelude = String.raw`
const { Worker, MessageChannel } = require("node:worker_threads");
const fs = require("node:fs");
const [out, workerPath] = process.argv.slice(2);
const workers = [], ports = [];
const deadline = setTimeout(() => { fs.writeFileSync(out, JSON.stringify({ timedOut: true })); process.exit(3); }, 20000);
function finish(value) {
  clearTimeout(deadline);
  fs.writeFileSync(out, JSON.stringify(value));
  for (const port of ports) port.close();
  for (const child of workers) child.terminate();
}
function start() { const child = new Worker(workerPath); workers.push(child); child.on("error", error => finish({ error: String(error) })); return child; }
function channel() { const pair = new MessageChannel(); ports.push(pair.port1); return pair; }
function gateWords(count) { return new Int32Array(new SharedArrayBuffer(count * 4)); }
function notify(gate, index = 0, value = 1) { Atomics.store(gate, index, value); Atomics.notify(gate, index); }
function afterReady(child, run, onResult = finish) { child.on("message", value => { if (value.ready) run(); else onResult(value.result); }); }
function receiver(send, mode, gate = gateWords(2)) {
  const child = start(), { port1, port2 } = channel();
  afterReady(child, () => { send(port1, gate); notify(gate); });
  child.postMessage({ port: port2, gate, mode }, [port2]);
  return { child, port1, gate };
}
`;
const deliver = (payload: string) => `receiver(port => port.postMessage(${payload}));`;
const cases: Record<string, Case> = {
  stock4: { main: deliver("{ signal: new SharedArrayBuffer(4) }"), expect: { first: { signal: 4, shared: true } } },
  coerced: { main: deliver('{ signal: new SharedArrayBuffer("8") }'), expect: { first: { signal: 8, shared: true } } },
  optionsObject: { main: deliver("{ signal: new SharedArrayBuffer(12, {}) }"), expect: { first: { signal: 12, shared: true } } },
  primitive: { main: deliver("{ v: 7 }"), expect: { first: { shared: false, v: 7 } } },
  preattached: {
    main: `const known = new SharedArrayBuffer(65537); const child = start(), { port1, port2 } = channel(), gate = gateWords(2);
      child.once("message", () => { port1.postMessage({ signal: known }); notify(gate); child.once("message", value => finish(value.result)); });
      child.postMessage({ port: port2, gate, known }, [port2]);`,
    expect: { first: { signal: 65537, shared: true } },
  },
  oversize: { main: deliver("{ signal: new SharedArrayBuffer(65537) }"), expect: { first: notAttached, later: { signal: 65537, shared: true } } },
  largeFresh: { main: deliver("{ signal: new SharedArrayBuffer(131072), v: 1 }"), expect: { first: notAttached, later: { signal: 131072, shared: true, v: 1 } } },
  zero: { main: deliver("{ signal: new SharedArrayBuffer(0) }"), expect: { first: notAttached, later: { signal: 0, shared: true } } },
  growable: { main: deliver("{ signal: new SharedArrayBuffer(4, { maxByteLength: 16 }) }"), expect: { first: notAttached, later: { signal: 4, shared: true } } },
  memory: { main: deliver('{ memory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }), v: "memory" }'), expect: { first: notAttached, later: { shared: false, v: "memory" } } },
  module: { main: deliver('{ module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), v: "module" }'), expect: { first: notAttached, later: { shared: false, v: "module" } } },
  exhausted: {
    main: `for (let index = 0; index < 32; index++) new SharedArrayBuffer(44); receiver(port => port.postMessage({ signal: new SharedArrayBuffer(44) }));`,
    expect: { first: notAttached, later: { signal: 44, shared: true } },
  },
  lastAdmitted: {
    main: `for (let index = 0; index < 31; index++) new SharedArrayBuffer(52); receiver(port => port.postMessage({ signal: new SharedArrayBuffer(52) }));`,
    expect: { first: { signal: 52, shared: true } },
  },
  transferredPort: {
    main: `let replied = false, parked = null;
      const settle = () => { if (replied && parked) finish({ ...parked, replied }); };
      const inner = channel(); inner.port1.on("message", value => { replied = value.v === "viaPort"; settle(); }); inner.port1.ref();
      const child = start(), { port1, port2 } = channel(), gate = gateWords(2);
      afterReady(child, () => { port1.postMessage({ signal: new SharedArrayBuffer(131072), inner: inner.port2 }, [inner.port2]); notify(gate); }, result => { parked = result; settle(); });
      child.postMessage({ port: port2, gate }, [port2]);`,
    expect: { first: notAttached, later: { signal: 131072, shared: true }, hasPort: true, replied: true },
  },
  freshReply: {
    main: `const inner = channel(), gate = gateWords(2);
      receiver((port, words) => { port.postMessage({ inner: inner.port2, signal: new SharedArrayBuffer(16) }, [inner.port2]); inner.port1.postMessage({ signal: new SharedArrayBuffer(4), v: "reply" }); notify(words, 1); }, "reply", gate);`,
    expect: { first: { signal: 16, shared: true }, reply: { signal: 4, shared: true, v: "reply" } },
  },
  loop: {
    main: `const gate = gateWords(2), child = start(), { port1, port2 } = channel();
      afterReady(child, () => {
        let round = 0;
        const step = () => {
          if (round >= 8) return;
          port1.postMessage({ signal: new SharedArrayBuffer(8) });
          round++; Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
          const expected = round;
          const acknowledged = () => { if (Atomics.load(gate, 1) < expected) setTimeout(acknowledged, 1); else step(); };
          acknowledged();
        };
        step();
      });
      child.postMessage({ port: port2, gate, mode: "loop" }, [port2]);`,
    expect: { count: 8, bytes: 64, thrown: null },
  },
  sibling: {
    main: `const gate = gateWords(2), sender = start(), target = start(), link = channel();
      let ready = 0;
      const go = () => { if (++ready === 2) notify(gate, 1); };
      target.on("message", value => { if (value.ready) go(); else finish(value.result); });
      sender.once("message", go);
      sender.postMessage({ gate, mode: "sendFresh", forward: link.port1 }, [link.port1]);
      target.postMessage({ port: link.port2, gate }, [link.port2]);`,
    expect: { first: { signal: 4, shared: true } },
  },
  forwardThird: {
    main: `const gate = gateWords(2), middle = start(), last = start(), first = channel(), second = channel();
      let ready = 0;
      const go = () => { if (++ready === 2) first.port1.postMessage({ signal: new SharedArrayBuffer(32) }); };
      last.on("message", value => { if (value.ready) go(); else finish(value.result); });
      middle.once("message", go);
      middle.postMessage({ port: first.port2, gate, mode: "forward", forward: second.port1 }, [first.port2, second.port1]);
      last.postMessage({ port: second.port2, gate }, [second.port2]);`,
    expect: { first: { signal: 32, shared: true } },
  },
  fidelity: {
    main: `const a = new SharedArrayBuffer(4); class Sub extends SharedArrayBuffer {} const s = new Sub(8);
      let grew = null; try { a.grow(8); } catch (error) { grew = error.constructor.name; }
      const growable = new SharedArrayBuffer(4, { maxByteLength: 16 }); growable.grow(8);
      let bad = null; try { new SharedArrayBuffer(4, { maxByteLength: 1 }); } catch (error) { bad = error.constructor.name; }
      finish({ length: a.byteLength, growable: a.growable, max: a.maxByteLength, instance: a instanceof SharedArrayBuffer,
        tag: Object.prototype.toString.call(a), identity: a.constructor === SharedArrayBuffer, subclass: s instanceof Sub, grew,
        requested: growable.byteLength, requestedGrowable: growable.growable, bad, evaluated: (0, eval)("new SharedArrayBuffer(4).growable") });`,
    expect: { length: 4, growable: false, max: 4, instance: true, tag: "[object SharedArrayBuffer]", identity: true, subclass: true, grew: "TypeError", requested: 8, requestedGrowable: true, bad: "RangeError", evaluated: false },
  },
};

const hostActivity = String.raw`
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const out = process.argv[2];
const piped = spawnSync("bun", ["-e", "console.log(1)"], { encoding: "utf8" });
const { Worker } = require("node:worker_threads");
const child = spawn("bun", ["-e", "setTimeout(()=>{},60000)"]);
const signalled = new Promise(resolve => child.on("exit", (_code, signal) => resolve(signal)));
fs.writeFileSync("/home/user/activity.txt", "x".repeat(70000));
const read = fs.readFileSync("/home/user/activity.txt", "utf8").length;
fs.rmSync("/home/user/activity.txt");
setTimeout(() => child.kill("SIGTERM"), 50);
const worker = new Worker("/home/user/worker.cjs");
const started = new Promise(resolve => worker.once("online", resolve));
Promise.all([signalled, started]).then(async ([signal]) => {
  await worker.terminate();
  fs.writeFileSync(out, JSON.stringify({ piped: piped.status, signal, read, stdout: piped.stdout }));
});
`;

async function runCase(page: Awaited<ReturnType<typeof newPage>>, name: string, program: string, argument = "") {
  const mainPath = `/home/user/${name}-main.cjs`, outPath = `/home/user/${name}-out.json`;
  await writeFile(page, mainPath, program);
  const result = await run(page, `bun ${mainPath} ${outPath}${argument}`, 30_000);
  assert.equal(result.code, 0, `${name} exit status: ${result.output}`);
  const body = await page.evaluate(async (path: string) => new TextDecoder().decode(await (globalThis as unknown as PlaygroundHook).playground.fs.readFile(path)), outPath);
  return JSON.parse(body) as Record<string, unknown>;
}
function poolOf(page: Awaited<ReturnType<typeof newPage>>) {
  return page.evaluate(() => (globalThis as unknown as PlaygroundHook).playground.sharedObjects.inspectPool());
}
async function newPage(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${url}?engine=browser&prompt=off&mode=memory`);
  assert.match(await ready(page), /ready/);
  return page;
}

for (const name of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${name}: blocked workers read admitted fresh shared messages, and name the boundary otherwise`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must supply BUN_WASM_BROWSER_SITE");
    const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-fresh-backing-"));
    const out = provided ? resolve(provided) : scratch!;
    const task = session("bun-wasm-fresh-backing-browser-");
    const previousRoot = process.env.ROOT;
    process.env.ROOT = join(out, "site");
    try {
      const before = provided ? verifySite(out) : buildSite(out);
      assert.ok(name === "chromium" || name === "webkit", `unsupported browser ${name}`);
      const url = await task.serve();
      const browser = await task.launch(name === "chromium" ? chromium : webkit);
      const page = await newPage(browser, url);
      await writeFile(page, "/home/user/worker.cjs", worker);
      const failures: string[] = [];
      for (const [caseName, testCase] of Object.entries(cases)) {
        const observed = await runCase(page, caseName, prelude + testCase.main, " /home/user/worker.cjs");
        console.log(`${name} ${caseName}: ${JSON.stringify(observed)}`);
        try { assert.deepEqual(observed, testCase.expect); }
        catch (error) { failures.push(`${caseName}: ${(error as Error).message}`); }
      }
      assert.deepEqual(failures, []);
      // Host activity spends no guest stock: spawn, pipes, files and signals change no class cursor.
      const before2 = await poolOf(page);
      const activity = await runCase(page, "host-activity", hostActivity);
      const after = await poolOf(page);
      console.log(`${name} host activity: ${JSON.stringify(activity)} classes ${JSON.stringify(after.classes)}`);
      assert.deepEqual(after.classes, before2.classes);
      // A Worker start takes a lane while any remain, so these cases can saturate the lane cursor.
      assert.ok(after.lanes >= before2.lanes && after.lanes <= 32, `lane claims ${after.lanes}`);
      assert.equal(activity.piped, 0);
      assert.equal(activity.signal, "SIGTERM");
      assert.equal(activity.read, 70000);
      assert.deepEqual(verifySite(out), before);
    } finally {
      if (previousRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = previousRoot;
      await task.cleanup();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
}
