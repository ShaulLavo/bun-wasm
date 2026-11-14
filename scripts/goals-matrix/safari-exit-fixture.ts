import { clock } from "./safari-protocol";
import { appendFileSync } from "node:fs";
import type { NativePort, ControlReceipt, ProcessClock } from "./safari-causal-native";
import { decodeExit, NOTE_EXIT, NOTE_EXITSTATUS, NOTE_EXIT_DETAIL } from "./safari-exit-decode";
import type { ExitOwner } from "./safari-exit-observer";

// Same reader model and owned-control receipt as the maintained causal-capture tests.
export function fakeNative() {
  const births = new Map([[101, "7"], [202, "9"]]);
  const cpu = new Map([[101, 0], [202, 0]]);
  const reads: number[] = [];
  const native: NativePort = {
    read(pid): ProcessClock | null { reads.push(pid); const birth = births.get(pid); return birth ? { cpuMs: cpu.get(pid) ?? 0, birth, footprintBytes: 4096 } : null; },
    async candidates() { return [101, 202]; },
    async control(): Promise<ControlReceipt> { return { passed: true, failure: null, label: "control", pid: 5, readErrno: null, cpuRatio: 1, birthStable: true,
      exitObserved: true, killerPid: 6, event: null, classes: ["signal-service"], jobRemoved: true, fileRemoved: true, startedAt: "", finishedAt: "" }; },
    async query() { return { events: [], ignored: 0 }; },
  };
  return { native, births, cpu, reads };
}

const raw = (pid: number, flags: number, data: number, fflags: number) => {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, BigInt(pid), true); view.setInt16(8, -5, true); view.setUint16(10, flags, true);
  view.setUint32(12, fflags, true); view.setBigInt64(16, BigInt(data), true);
  return { ident: String(pid), filter: -5, flags, fflags, data: String(data), udata: "0", ext: ["0", "0"], hex: Buffer.from(bytes).toString("hex") };
};

export function fakeSubscription(pid = 101) {
  const interest = "status-detail" as const;
  const mask = (NOTE_EXIT | NOTE_EXITSTATUS | NOTE_EXIT_DETAIL) >>> 0;
  const registration = { interest, dispatched: clock(), settled: clock(), count: 1, errno: 0,
    change: raw(pid, 0x41, 0, mask), receipt: raw(pid, 0x4041, 0, mask) };
  const queue: ReturnType<ReturnType<typeof import("./safari-exit-syscalls").openExit>["poll"]>[] = [];
  let closes = 0;
  let polls = 0;
  let pollFailure: unknown;
  let closeFailure: unknown;
  const subscription: ReturnType<typeof import("./safari-exit-syscalls").openExit> = {
    pid, interest, registration,
    poll() {
      polls++;
      if (pollFailure) throw pollFailure;
      return queue.shift() ?? { kind: "empty", dispatched: clock(), settled: clock(), count: 0 };
    },
    close() { closes++; if (closeFailure) throw closeFailure; },
    closeReceipt: null,
  };
  return { subscription, queue, get closes() { return closes; }, get polls() { return polls; },
    failPoll(error: unknown) { pollFailure = error; }, failClose(error: unknown) { closeFailure = error; },
    event(data = 5888, fflags = mask) {
      const event = { kind: "event", dispatched: clock(), settled: clock(), count: 1, raw: raw(pid, 0x8071, data, fflags), decoded: decodeExit(fflags, data) } satisfies ReturnType<typeof subscription.poll>;
      queue.push(event);
      return event;
    },
  };
}

export function endpoint(native: ReturnType<typeof fakeNative>, options: { fail?: "null" | "404" | "hang-delete" } = {}) {
  const requests: { path: string; method: string }[] = [];
  const portFile = process.env.LIFECYCLE_PORT_LEDGER;
  let closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, method: request.method });
    if (path === "/session") return Response.json({ value: { sessionId: "owned", capabilities: { browserName: "Safari", platformName: "macOS" } } });
    if (path.endsWith("/window")) return Response.json({ value: "host" });
    if (path.endsWith("/execute/async")) return evaluation(await request.json());
    if (path === "/session/owned" && options.fail === "hang-delete") await Bun.sleep(500);
    if (path === "/session/owned" && options.fail === "404") return invalid();
    return Response.json({ value: null });
  } });
  if (portFile) appendFileSync(portFile, String(server.port) + "\n");
  function evaluation(body: unknown): Response {
    if (body === null || typeof body !== "object" || !("args" in body) || !Array.isArray(body.args) || typeof body.args[0] !== "string") throw new Error("Invalid fixture request");
    const expression = body.args[0];
    if (!expression.includes("performance.now() +")) return options.fail === "404" ? invalid() : Response.json({ value: null });
    const start = performance.now();
    const value: unknown = Function("return " + expression)();
    native.cpu.set(101, (native.cpu.get(101) ?? 0) + performance.now() - start);
    return Response.json({ value: { ok: true, json: JSON.stringify(value) } });
  }
  function invalid() { return Response.json({ value: { error: "invalid session id", message: "fixture" } }, { status: 404 }); }
  return { url: server.url.href, requests, port: server.port, async stop() { if (!closed) await server.stop(true); closed = true; } };
}

export function targetRecords(owner: ExitOwner, kind: string) { return owner.records.filter(entry => entry.kind === kind); }
