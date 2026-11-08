import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { loadBunWasm, programLinkPlan } from "../../../src/assets.ts";
import { ENGINE_BIN, engineEnvironment } from "../../../src/executable-paths.ts";
import { markStarted } from "waffle/proc/outcome";
import { workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { parseProgramFiles, programProfile } from "../../../src/engine-kind.ts";
import { linkNodeProgram } from "../../scripts/node-linked.ts";
import { NodeProcessBroker } from "../../scripts/node-spawn.ts";
import { createNodeProcess } from "../../scripts/node-process.ts";

const root = process.argv[2];
if (!root) throw new Error("Fixture pair directory required");
const kind = "spidermonkey";
const files = parseProgramFiles({ kind,
  core: readFileSync(join(root, programProfile(kind).core)),
  side: readFileSync(join(root, programProfile(kind).side)),
}, bytes => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Fixture bytes required");
  return bytes;
});
const descriptor = (bytes: Uint8Array, name: string) => ({
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: pathToFileURL(join(root, name)).href,
});
if (files.kind !== kind) throw new Error("Wrong fixture kind");
const module = await loadBunWasm({ asset: { kind,
  core: descriptor(files.core, programProfile(kind).core), side: descriptor(files.side, programProfile(kind).side),
}, fetch: async url => new Response(readFileSync(new URL(url))) });
const source = programLinkPlan(module);
if (!source) throw new Error("Host lost its link plan");
const linked = await linkNodeProgram(source, { runtime_proc: { signal: () => 0 } });
let hostValue: unknown;
try {
  linked.initialize();
  const value = linked.entry.exports.value;
  if (typeof value !== "function") throw new Error("Host value export missing");
  hostValue = value();
} finally { linked.dispose(); }

const observed: unknown[] = [], errors: string[] = [], messages: WorkerProcessMessage[] = [];
const ambient = process.env.BUN_WASM_SPIDERMONKEY_TIER;
const base = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
const broker = new NodeProcessBroker({ module: base, engines: { spidermonkey: module },
  onError: error => errors.push(String(error)),
  launch(context, transport) {
    if (context.module !== module) throw new Error("Wrong selected child module");
    markStarted(workerProcessState(transport).signals.outcome);
    const worker = new Worker(new URL("./spidermonkey-tier-worker.ts", import.meta.url), {
      workerData: { module: context.module, files, env: context.request.env },
    });
    worker.on("message", message => observed.push(message));
    return worker;
  },
});
const host = createNodeProcess({ transport: broker.root,
  postMessage: message => messages.push(structuredClone(message)),
  finish(): never { throw new Error("Unexpected fixture root exit"); },
});
try {
  const children = ["interp", "pbl"].map(tier => host.client.spawn(host.client.pid, {
    executable: `${ENGINE_BIN[kind]}/bun`, argv: ["bun"], cwd: "/", job: 0, fds: [],
    env: engineEnvironment(kind, { BUN_WASM_SPIDERMONKEY_TIER: tier }),
  }));
  await Promise.all(messages.splice(0).map(message => broker.broker.handle(message, host.client.pid)));
  const results = await Promise.all(children.map(pid => broker.supervisor.waitForExit(host.client.pid, pid)));
  process.stdout.write(JSON.stringify({ hostValue, observed, errors, statuses: results.map(result => result.status),
    environmentUnchanged: process.env.BUN_WASM_SPIDERMONKEY_TIER === ambient }));
} finally { host.dispose(); await broker.dispose(); }
