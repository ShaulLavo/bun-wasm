import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { ProcessService, RuntimeProcessContext } from "waffle";
import { outcomeWord } from "waffle/proc/outcome";
import { ENGINE_BIN } from "../../src/executable-paths.ts";
import { installActorObserver, selectActor } from "../../scripts/verify-engine-memory-browser.ts";
import { bunLauncher } from "../src/bun-launcher.ts";
import type { RunRequest } from "../src/bun-executor.ts";
import { processRuntimeFixture } from "./process-runtime-fixture.ts";
import { networkPathScopeFixture, socketDirectoryFixture } from "./socket-runtime-fixture.ts";

type Engine = "quickjs" | "jsc";
type Launch = { request: Pick<RunRequest, "engine" | "args" | "env" | "memoryTelemetry">; cleanup?(): void };
const path = "/home/user/memory-producer.ts";
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

async function fixtureLaunch(engine: Engine, argv0: string): Promise<Launch["request"]> {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  let launched: Launch | undefined;
  const context = { identity: { pid: 1, parentPid: 0, host: null }, outcome: outcomeWord(), registerRevocation: () => () => {},
    module, interruptible: false, job: 1,
    request: { executable: `${ENGINE_BIN[engine]}/bun`, argv: [argv0, "run", path], cwd: "/home/user",
      env: { BUNWASM_EXEC_PATH: "/wrong/caller-supplied/bun" } },
  } as unknown as RuntimeProcessContext;
  const service = { networkPathScope: networkPathScopeFixture,
    launchWorker(_context: unknown, launch: Launch) { launched = launch; return { terminate() {} }; },
  } as unknown as ProcessService;
  try {
    await bunLauncher(engine, { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(context, service);
    if (!launched) throw new Error("fixture worker was not launched");
    expect(launched.request.args).toBe(context.request.argv);
    expect(launched.request.env.BUNWASM_EXEC_PATH).toBe(`${ENGINE_BIN[engine]}/bun`);
    return launched.request;
  } finally {
    launched?.cleanup?.();
    await runtime.dispose();
  }
}

function observe(engine: Engine, messages: readonly unknown[]): unknown {
  const sent: unknown[] = [];
  class TransportWorker { postMessage(message: unknown) { sent.push(message); } }
  const scope = { Worker: TransportWorker, SharedArrayBuffer };
  // Execute the same self-contained function Playwright serializes into the real page.
  const install: unknown = runInNewContext(`(${installActorObserver.toString()})`, scope);
  if (typeof install !== "function") throw new Error("observer is not serializable");
  install({ engine, executable: `${ENGINE_BIN[engine]}/bun`, paths: [path] });
  const worker = new TransportWorker();
  for (const message of messages) worker.postMessage(message);
  expect(sent).toHaveLength(messages.length);
  for (const [index, message] of messages.entries()) expect(sent[index]).toBe(message);
  const getter: unknown = Reflect.get(scope, "__bunMemoryVerifierActors");
  if (typeof getter !== "function") throw new Error("observer is unavailable");
  return getter();
}

for (const engine of ["quickjs", "jsc"] as const) {
  for (const argv0 of ["bun", `${ENGINE_BIN[engine]}/bun`]) test(`${engine} observer accepts the source launcher transport for ${argv0}`, async () => {
    const request = await fixtureLaunch(engine, argv0);
    if (!request.memoryTelemetry) throw new Error("launcher omitted memory telemetry");
    expect(selectActor(observe(engine, [request]), { engine, path })).toEqual({
      authority: "host-worker-launch", id: request.memoryTelemetry.id, engine, path,
    });
  });
}

test("source launcher transport rejects malformed fixture arguments, authority and telemetry", async () => {
  const engine = "quickjs";
  const request = await fixtureLaunch(engine, "bun");
  const malformed = [
    { label: "engine", message: { ...request, engine: "jsc" } },
    { label: "Hermes engine", message: { ...request, engine: "hermes" } },
    { label: "argument count", message: { ...request, args: request.args.concat(["extra"]) } },
    { label: "command", message: { ...request, args: ["bun", "eval", path] } },
    { label: "argv0 type", message: { ...request, args: [null, "run", path] } },
    { label: "argv0 spelling", message: { ...request, args: ["/wrong/bun", "run", path] } },
    { label: "executable authority", message: { ...request, env: { BUNWASM_EXEC_PATH: "/wrong/bun" } } },
    { label: "missing executable authority", message: { ...request, env: {} } },
    { label: "missing environment", message: { ...request, env: null } },
    { label: "telemetry", message: { ...request, memoryTelemetry: undefined } },
    { label: "telemetry id", message: { ...request, memoryTelemetry: { ...request.memoryTelemetry, id: "" } } },
    { label: "telemetry id type", message: { ...request, memoryTelemetry: { ...request.memoryTelemetry, id: 1 } } },
    { label: "telemetry buffer", message: { ...request, memoryTelemetry: { ...request.memoryTelemetry, buffer: new ArrayBuffer(8192) } } },
  ];
  for (const { label, message } of malformed) {
    expect(() => selectActor(observe(engine, [message]), { engine, path }), label).toThrow("valid host fixture launch required");
  }
  expect(() => selectActor(observe(engine, [{ ...request, args: ["bun", "run", `${path}.wrong`] }]), { engine, path })).toThrow("unique host fixture launch required");
  expect(() => selectActor(observe(engine, [request, request]), { engine, path })).toThrow("unique host fixture launch required");
});
