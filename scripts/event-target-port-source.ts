import { readFileSync } from "node:fs";
import { runInContext } from "node:vm";
import { eventTargetSource } from "./event-target-source";
import { bootstrapTimers } from "./fixtures/bootstrap-timer-runtime";

/** Real factories and canonical tables; only private staging is exposed to fault controls. */
export function eventTargetPortSource() {
  const source = eventTargetSource({ TextDecoder, TextEncoder, setImmediate });
  const clock = bootstrapTimers();
  Object.assign(source.context, { clock: clock.runtime });
  const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const name of ["worker_codec", "worker_threads", "web_worker"]) {
    let input = readFileSync(new URL(name + ".ts", directory), "utf8");
    if (name === "worker_threads") input = exposePortControls(input);
    runInContext(transpiler.transformSync(`globalThis.${name}Factory = ${input}`), source.context);
  }
  runInContext(`
    const waiters = [];
    const processFixture = { env: {}, execArgv: [], cwd: () => '/' };
    internal.realTimers = clock.realTimers;
    internal.messagePortRefs = clock.messagePortRefs;
    internal.addIoWaiter = value => { waiters.push(value); return value; };
    internal.initImportMeta = () => {};
    internal.runMain = () => {};
    internal.native.utf8Decode = bytes => new TextDecoder().decode(bytes);
    internal.require = name => {
      if (name === 'process') return processFixture;
      if (name === 'events') return events;
      if (name === 'net') return {};
      if (name === 'structured_clone') return { structuredClone() { throw new Error('Unused clone'); } };
      if (name === 'worker_codec') return worker_codecFactory(internal);
      if (name === 'worker_threads') return ports;
      throw new Error('Unexpected module ' + name);
    };
    const ports = worker_threadsFactory(internal);
    clock.workerPump = () => internal.workerPump();
    const worker = web_workerFactory(internal);
    const assert = (value, message = 'source assertion failed') => { if (!value) throw new Error(message); };
    const flush = () => { while (clock.loopState().immediates) clock.runTimers(); };
    const cleanup = () => { ports.__fixtureShutdown(); flush(); assert(internal.messagePortRefs.size === 0, 'leaked ref'); };
  `, source.context);
  return source;
}

function exposePortControls(source: string) {
  const target = "return exports;";
  if (source.split(target).length !== 2) throw new Error("Nonunique port fixture hook");
  return source.replace(target, `return Object.assign(exports, {
    __fixturePrepare: portOps.prepare,
    __fixtureForward: portOps.forward,
    __fixtureShutdown() { for (const port of Array.from(localPorts.values())) port.close(); }
  });`);
}
