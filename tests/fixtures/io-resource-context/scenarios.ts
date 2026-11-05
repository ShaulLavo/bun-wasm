// One scenario per row in rows.ts. Each registers its resource in a named frame through the real
// guest API, drives a real event, and records `see(site, ...)` with the frame current at the callback.
import { AsyncLocalStorage } from "node:async_hooks";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch, writeFileSync, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RowId, Value } from "./rows.ts";

export interface Context {
  readonly storage: AsyncLocalStorage<string>;
  /** The server row.ts started before entering any frame, for the root-registration row. */
  readonly early: Server | undefined;
  see(site: string, ...values: Value[]): void;
  count(site: string): number;
  /** Resolves once `count` records for `site` exist, or after the row's wait limit. */
  until(site: string, count?: number): Promise<void>;
  /** Prints a stdin gate marker line for the orchestrator. */
  mark(marker: "READY" | "GATE"): void;
  arm(armed: boolean): void;
}
type Scenario = (context: Context) => Promise<void>;
type Server = Bun.Server<undefined>;

const payload = fileURLToPath(new URL("payload.ts", import.meta.url));
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

function file(name: string): string {
  const path = resolve(name);
  writeFileSync(path, "0");
  return path;
}

async function mutate(path: string): Promise<void> {
  await sleep(20);
  writeFileSync(path, "1");
}

function errorCode(error: unknown): Value {
  if (error === null || error === undefined) return null;
  const code: unknown = typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : String(error);
}

function messageValue(message: unknown): Value {
  if (message === null || typeof message !== "object") return null;
  if (Reflect.get(message, "kind") === "ready") return "ready";
  const value: unknown = Reflect.get(message, "ack") ?? Reflect.get(message, "n");
  return typeof value === "number" ? value : null;
}

function exited(child: ChildProcess): Promise<unknown> {
  return child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
}

function firstOnly(callback: () => void): () => void {
  let seen = false;
  return () => {
    if (seen) return;
    seen = true;
    callback();
  };
}

async function watchRegistration(context: Context): Promise<void> {
  const path = file("watch-registration.txt");
  let first = true;
  function changed(this: unknown): void {
    if (!first) return;
    first = false;
    context.see("change", this === watcher);
  }
  const watcher: FSWatcher = context.storage.run("A", () => watch(path, changed));
  context.see("caller");
  await mutate(path);
  await context.until("change");
  watcher.close();
}

async function watchTwoStores(context: Context): Promise<void> {
  const paths = [file("watch-one.txt"), file("watch-two.txt")];
  const watchNamed = (name: string, index: number) => {
    const changed = firstOnly(() => context.see(name));
    return context.storage.run(name, () => watch(paths[index]!, changed));
  };
  const watchers = ["one", "two"].map(watchNamed);
  await mutate(paths[0]!);
  await mutate(paths[1]!);
  await context.until("one");
  await context.until("two");
  for (const watcher of watchers) watcher.close();
}

async function watchCallerClose(context: Context): Promise<void> {
  const watcher = context.storage.run("A", () => watch(file("watch-close.txt")));
  watcher.on("close", () => context.see("close"));
  context.storage.run("C", () => watcher.close());
  context.see("caller");
  await context.until("close");
}

async function watchAbort(context: Context): Promise<void> {
  const controller = new AbortController();
  const watcher = context.storage.run("A", () => watch(file("watch-abort.txt"), { signal: controller.signal }));
  watcher.on("close", () => context.see("close"));
  context.storage.run("D", () => controller.abort());
  context.see("caller");
  await context.until("close");
}

async function watchCloseInCallback(context: Context): Promise<void> {
  const path = file("watch-dispatch.txt");
  const queued = () => context.see("queued");
  const watcher: FSWatcher = context.storage.run("A", () => watch(path, () => {
    context.see("change");
    setImmediate(queued);
    watcher.close();
  }));
  watcher.on("close", () => context.see("close"));
  await mutate(path);
  await context.until("queued");
}

async function watchCloseThenThrow(context: Context): Promise<void> {
  const path = file("watch-throw.txt");
  const thrown = new Error("listener");
  const watcher: FSWatcher = context.storage.run("A", () => watch(path, () => {
    context.see("change");
    watcher.close();
    throw thrown;
  }));
  watcher.on("error", error => context.see("error", error === thrown));
  watcher.on("close", () => context.see("close"));
  await mutate(path);
  await context.until("close");
}

function forkPayload(context: Context, mode: string): ChildProcess {
  return context.storage.run("A", () => fork(payload, [mode]));
}

async function ipcMessageEof(context: Context): Promise<void> {
  const child = forkPayload(context, "ipc-burst");
  child.on("message", message => context.see("message", messageValue(message)));
  child.on("disconnect", () => context.see("disconnect"));
  child.on("exit", code => context.see("exit", code));
  await context.until("exit");
  await context.until("disconnect");
}

async function ipcCallerDisconnect(context: Context): Promise<void> {
  const child = forkPayload(context, "ipc-wait");
  child.on("message", message => {
    context.see("message", messageValue(message));
    context.storage.run("C", () => child.disconnect());
    context.see("caller");
  });
  child.on("disconnect", () => context.see("disconnect"));
  child.on("exit", code => context.see("exit", code));
  await context.until("exit");
  await context.until("disconnect");
}

async function ipcImmediateSend(context: Context): Promise<void> {
  const child = forkPayload(context, "ipc-wait");
  const done = exited(child);
  const sent = (error: Error | null) => context.see("send", errorCode(error));
  child.on("message", message => {
    const value = messageValue(message);
    context.see("message", value);
    if (value === 1) child.send({ kind: "exit" });
    if (value !== "ready") return;
    context.storage.run("B", () => child.send({ n: 1, ack: true }, sent));
  });
  await done;
}

// The child sleeps in its message loop while a 2 MiB send in B and a later send in D are queued.
// The row is armed only if neither callback ran before the checkpoint, well inside the stall.
function blockedSends(context: Context, child: ChildProcess): void {
  child.send({ kind: "stall", ms: 1500 });
  context.storage.run("B", () => child.send({ n: 1, blob: "x".repeat(2 << 20) }, error => context.see("send-B", errorCode(error))));
  context.storage.run("D", () => child.send({ n: 2, ack: true }, error => context.see("send-D", errorCode(error))));
  setTimeout(() => context.arm(context.count("send-B") === 0 && context.count("send-D") === 0), 200);
}

async function ipcBlockedSend(context: Context): Promise<void> {
  const child = forkPayload(context, "ipc-wait");
  const done = exited(child);
  child.on("message", message => {
    const value = messageValue(message);
    if (value !== "ready" && value !== 2) return;
    context.see("message", value);
    if (value === "ready") blockedSends(context, child);
    else child.send({ kind: "exit" });
  });
  await done;
}

async function spawnBunOnExit(context: Context): Promise<void> {
  const options = {
    stdin: "ignore" as const, stdout: "ignore" as const, stderr: "inherit" as const,
    onExit(this: unknown, subprocess: unknown, code: number | null, signal: number | null, error?: unknown) {
      context.see("onExit", this === options, subprocess === child, code, signal, errorCode(error));
    },
  };
  const child = context.storage.run("A", () => Bun.spawn([process.execPath, payload, "exit", "3"], options));
  context.see("caller");
  context.storage.run("reaction", () => child.exited.then(code => context.see("exited", code)));
  await context.until("exited");
}

async function spawnStartupFailure(context: Context): Promise<void> {
  const missing = resolve("missing-io-resource-context-program");
  context.storage.run("A", () => {
    try {
      Bun.spawn([missing]);
    } catch (error) {
      context.see("threw", errorCode(error));
    }
  });
  context.see("caller");
  const child = context.storage.run("A", () => spawn(missing, [], { stdio: "ignore" }));
  child.on("error", error => context.see("node-error", errorCode(error)));
  await context.until("node-error");
}

async function spawnNodeEvents(context: Context): Promise<void> {
  const child = context.storage.run("A", () => spawn(process.execPath, [payload, "exit", "0"], { stdio: "ignore" }));
  child.on("spawn", () => context.see("spawn"));
  child.on("exit", code => context.see("exit", code));
  child.on("close", code => context.see("close", code));
  await context.until("close");
}

function stdinInB(context: Context, onData: (chunk: string) => void): NodeJS.ReadStream {
  const stdin = process.stdin;
  context.storage.run("B", () => {
    stdin.on("data", chunk => {
      context.see("data", String(chunk));
      onData(String(chunk));
    });
    stdin.on("end", () => context.see("end"));
    stdin.resume();
  });
  context.mark("READY");
  return stdin;
}

async function stdinConstructA(context: Context): Promise<void> {
  const stdin = context.storage.run("A", () => process.stdin);
  context.storage.run("B", () => {
    stdin.on("data", chunk => context.see("data", String(chunk)));
    stdin.on("end", () => context.see("end"));
    stdin.resume();
  });
  context.mark("READY");
  await context.until("end");
}

async function stdinNextReadD(context: Context): Promise<void> {
  const stdin = stdinInB(context, () => {
    if (context.count("data") !== 1) return;
    context.storage.run("D", () => stdin.read(0));
    context.mark("GATE");
  });
  await context.until("end");
}

async function stdinPauseResume(context: Context): Promise<void> {
  const resumeInD = () => {
    context.storage.run("D", () => stdin.resume());
    context.mark("GATE");
  };
  const stdin = stdinInB(context, () => {
    if (context.count("data") !== 1) return;
    context.storage.run("C", () => stdin.pause());
    setImmediate(resumeInD);
  });
  await context.until("end");
}

async function stdinRedundantRead(context: Context): Promise<void> {
  const readInD = () => {
    context.storage.run("D", () => stdin.read(0));
    context.mark("GATE");
  };
  const resumeInC = () => {
    context.storage.run("C", () => stdin.resume());
    setImmediate(readInD);
  };
  const stdin = stdinInB(context, () => {
    if (context.count("data") !== 1) return;
    context.storage.run("C", () => stdin.pause());
    setImmediate(resumeInC);
  });
  await context.until("end");
}

async function stdinDestroyPending(context: Context): Promise<void> {
  const stdin = stdinInB(context, () => {});
  context.storage.run("B", () => stdin.on("close", () => context.see("close")));
  await sleep(50);
  context.storage.run("C", () => stdin.destroy());
  context.see("caller");
  await context.until("close");
}

/** row.ts also starts one before it enters any frame, so that registration is truly at root. */
export function routeServer(see: Context["see"]): Server {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, routes: { "/": () => {
    see("route");
    return new Response("ok");
  } } });
}

async function request(context: Context, server: Server, path: string): Promise<string> {
  return await context.storage.run("F", () => fetch(new URL(path, server.url)).then(response => response.text()));
}

async function serveOnce(context: Context, server: Server): Promise<void> {
  context.see("caller", await request(context, server, "/"));
  await server.stop(true);
}

async function serveRunA(context: Context): Promise<void> {
  await serveOnce(context, context.storage.run("A", () => routeServer(context.see)));
}

async function serveEnterWithA(context: Context): Promise<void> {
  await serveOnce(context, context.storage.run("X", () => {
    context.storage.enterWith("A");
    return routeServer(context.see);
  }));
}

async function serveRoot(context: Context): Promise<void> {
  if (!context.early) throw new Error("root-registration row needs its early server");
  await serveOnce(context, context.early);
}

// Two requests run in their own request store and both wait on one barrier, so each handler
// resumes while the other request's store exists. A later idle request must see neither.
async function serveTwoStores(context: Context): Promise<void> {
  const requests = new AsyncLocalStorage<string>();
  const barrier = Promise.withResolvers<void>();
  let arrived = 0;
  let released = false;
  const release = (overlapped: boolean) => {
    if (released) return;
    released = true;
    context.see("overlap", overlapped);
    barrier.resolve();
  };
  const timer = setTimeout(release, 3000, false);
  const arrive = () => {
    if (++arrived === 2) release(true);
  };
  const handle = (id: string) => requests.run(id, async () => {
    context.see(`start:${id}`, id);
    arrive();
    await barrier.promise;
    context.see(`after:${id}`, requests.getStore() ?? null);
    return new Response(id);
  });
  const server = context.storage.run("A", () => Bun.serve({ hostname: "127.0.0.1", port: 0, routes: {
    "/request": req => handle(new URL(req.url).searchParams.get("id") ?? ""),
    "/idle": () => {
      context.see("idle", requests.getStore() ?? null);
      return new Response("idle");
    },
  } }));
  await Promise.all(["one", "two"].map(id => request(context, server, `/request?id=${id}`)));
  context.see("caller", await request(context, server, "/idle"));
  clearTimeout(timer);
  await server.stop(true);
}

export const scenarios = {
  "watch.change-registration": watchRegistration,
  "watch.two-stores": watchTwoStores,
  "watch.caller-close": watchCallerClose,
  "watch.abort": watchAbort,
  "watch.close-in-callback": watchCloseInCallback,
  "watch.close-then-throw": watchCloseThenThrow,
  "ipc.message-eof": ipcMessageEof,
  "ipc.caller-disconnect": ipcCallerDisconnect,
  "ipc.immediate-send": ipcImmediateSend,
  "ipc.blocked-send": ipcBlockedSend,
  "spawn.bun-onexit": spawnBunOnExit,
  "spawn.startup-failure": spawnStartupFailure,
  "spawn.node-events": spawnNodeEvents,
  "stdin.construct-A-activate-B": stdinConstructA,
  "stdin.next-read-D": stdinNextReadD,
  "stdin.pause-C-resume-D": stdinPauseResume,
  "stdin.resume-C-redundant-D": stdinRedundantRead,
  "stdin.destroy-pending": stdinDestroyPending,
  "serve.explicit-run-A": serveRunA,
  "serve.explicit-enterWith-A": serveEnterWithA,
  "serve.root-registration": serveRoot,
  "serve.two-store-overlap": serveTwoStores,
} satisfies Record<RowId, Scenario>;
