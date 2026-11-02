import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { assertPreviewPageOrigin, verifyReplayAdmission } from "./next-acceptance-admission";
import { observerHooks, requireServingObserver } from "./next-acceptance-observer";
import { routeCoverage, verifyTaggedPhaseCoverage, verifyPhaseObservationControls, phaseControlRequests, phaseSenderControl, type CoveredRoute } from "./next-acceptance-phase-coverage";
import { verifyRegistryInventory, type RegistryEntry } from "../../web/tests/next-framework-registry";

const previewOrigin = "https://source-only-preview.invalid/";
const appPhases = ["handle-request-dev", "handle-request-base", "find-page-components-dev", "find-page-components-parent", "render-components"];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

test("preview admission checks the exact HTTP request page, not an opaque document", () => {
  for (const url of ["about:blank", "data:text/html,ready", "blob:https://source-only-preview.invalid/id", "https://different-ready-page.invalid/"]) {
    expect(() => assertPreviewPageOrigin(url, previewOrigin)).toThrow();
  }
  expect(() => assertPreviewPageOrigin(previewOrigin + "dynamic", previewOrigin)).not.toThrow();
});

test("the driver's actual readiness block admits the page used by later requests", async () => {
  const text = readFileSync(join(import.meta.dir, "next-acceptance.ts"), "utf8");
  const start = text.indexOf("async function serverCases(");
  const end = text.indexOf("\nasync function serverPid(", start);
  expect(start).toBeGreaterThan(0);
  const source = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(text.slice(start, end));
  const page = sourcePage();
  const admitted: string[] = [];
  const run = runInNewContext(source + "\nserverCases", {
    timeout: 180000, phaseObservation: false, Date, assert, assertPreviewPageOrigin,
    phase: async (_name: string, operation: () => Promise<void>) => { await operation(); return true; },
    waitForPreviewReady: async (candidate: ReturnType<typeof sourcePage>, base: string) => { await candidate.goto(base); },
    routeCases: ["source-only-tagged-request"], alive: async () => {},
    runRouteCase: async (_name: string, candidate: ReturnType<typeof sourcePage>) => { admitted.push(candidate.url()); },
  });
  await run({}, page, previewOrigin, "start", {}, {});
  expect(admitted).toEqual([previewOrigin]);
  expect(page.isClosed()).toBe(false);
});

function sourcePage() {
  let url = "about:blank";
  let closed = false;
  return {
    url: () => url, goto: async (next: string) => { url = next; return { ok: () => true }; },
    close: async () => { closed = true; }, isClosed: () => closed,
    context: () => ({ newPage: async () => sourcePage() }),
  };
}

test("app handlers may finish HTTP without the class sender", () => {
  for (const route of ["api/context", "dynamic", "missing-acceptance"] satisfies CoveredRoute[]) {
    expect(() => verifyTaggedPhaseCoverage(terminal(route), probe(route), route)).not.toThrow();
  }
});

test("a distinct Pages positive control requires a complete class sender interval", () => {
  const route = "phase-sender-control";
  expect(() => verifyTaggedPhaseCoverage(terminal(route), probe(route), route)).not.toThrow();
  for (const suffix of ["entry", "return", "resolve"]) {
    const incomplete = records(route).filter(record => record.stage !== `send-render-result:${suffix}`);
    expect(() => verifyTaggedPhaseCoverage(lines(incomplete), probe(route), route)).toThrow();
  }
});

test("an observed app class sender must also have a complete same-call interval", () => {
  const source = records("dynamic").concat(interval("send-render-result", 20, "dynamic"));
  expect(() => verifyTaggedPhaseCoverage(lines(source), probe("dynamic"), "dynamic")).not.toThrow();
  expect(() => verifyTaggedPhaseCoverage(lines(source.filter(row => row.stage !== "send-render-result:resolve")), probe("dynamic"), "dynamic")).toThrow();
});

test("request object, URL, method, status and actual HTTP writer coverage are mandatory", () => {
  const mutations = [
    (rows: ReturnType<typeof records>) => rows.filter(row => row.stage !== "end:entry"),
    (rows: ReturnType<typeof records>) => rows.filter(row => row.stage !== "writeHead:return"),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "request-event" ? { ...row, requestIsIncomingMessage: false } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "request-event" ? { ...row, responseIsServerResponse: false } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "request" ? { ...row, url: "/another-route" } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "request" ? { ...row, method: "POST" } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "end:return" ? { ...row, status: 500 } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "end:return" ? { ...row, headersSent: false } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "end:return" ? { ...row, requestId: 2 } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => ({ ...row, correlation: "missing" })),
    (rows: ReturnType<typeof records>) => rows.map(row => ({ ...row, at: "not-a-timestamp" })),
    (rows: ReturnType<typeof records>) => rows.map(row => ({ ...row, requestId: -1 })),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "render-components:return" ? { ...row, callId: 999 } : row),
    (rows: ReturnType<typeof records>) => rows.map(row => row.stage === "render-components:resolve" ? { ...row, at: -1 } : row),
  ];
  for (const mutate of mutations) expect(() => verifyTaggedPhaseCoverage(lines(mutate(records("dynamic"))), probe("dynamic"), "dynamic")).toThrow();
});

test("missing-route coverage requires the compile interval without a class-sender assumption", () => {
  const source = records("missing-acceptance").filter(row => !row.stage.startsWith("ensure-page:"));
  expect(() => verifyTaggedPhaseCoverage(lines(source), probe("missing-acceptance"), "missing-acceptance")).toThrow();
});

test("tagged coarse lookup spans do not become direct loadComponents observations", () => {
  const source = records("dynamic").filter(row => !row.stage.startsWith("find-page-components-parent:"));
  source.push(...interval("load-components", 20, "dynamic"));
  expect(() => verifyTaggedPhaseCoverage(lines(source), probe("dynamic"), "dynamic")).toThrow();
});

function probe(route: string) { return `phase-source-fixture-${route}`; }
function terminal(route: CoveredRoute) { return lines(records(route)); }
function lines(rows: readonly Record<string, unknown>[]) {
  return rows.map(row => "[guest-error-phase] " + JSON.stringify(row)).join("\n");
}
function record(stage: string, route: string) {
  return { probe: probe(route), stage, at: stage === "request" || stage === "request-event" ? 1 : 10, requestId: 1, correlation: "request-object-async-context",
    method: "GET", url: `/${route}`, status: route === "missing-acceptance" ? 404 : 200,
    requestIsIncomingMessage: true, responseIsServerResponse: true, headersSent: true, callId: 0 };
}
function interval(name: string, callId: number, route: string) {
  return ["entry", "return", "resolve"].map((suffix, offset) => ({ ...record(`${name}:${suffix}`, route), at: 2 + offset, callId }));
}
function records(route: CoveredRoute) {
  const names = appPhases.concat(route === "missing-acceptance" ? ["ensure-page"] : [], route === "phase-sender-control" ? ["send-render-result"] : []);
  return ["request-event", "request", "writeHead:entry", "writeHead:return", "end:entry", "end:return", "finish"]
    .map(stage => record(stage, route)).concat(names.flatMap((name, index) => interval(name, index + 1, route)));
}

function withReplay(run: (directory: string, entries: Record<string, RegistryEntry>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-next-source-inventory-"));
  try {
    mkdirSync(join(directory, "objects"));
    const tarball = Buffer.from("original tarball");
    const metadata = Buffer.from('{"dist-tags":{"latest":"1.0.0"}}');
    const entries = {
      "/pkg/-/pkg.tgz": { status: 200, type: "application/octet-stream", sha256: digest(tarball) },
      "/-/package/next/dist-tags": { status: 200, type: "application/json", sha256: digest(metadata) },
    };
    for (const bytes of [tarball, metadata]) writeFileSync(join(directory, "objects", digest(bytes)), bytes);
    writeFileSync(join(directory, "index.json"), JSON.stringify(entries));
    run(directory, entries);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("complete original replay bytes pass, tarball-only and mutated metadata fail", () => {
  withReplay((directory, entries) => {
    const path = join(directory, "objects", entries["/-/package/next/dist-tags"]!.sha256);
    const bytes = readFileSync(path);
    const verified = verifyRegistryInventory(directory, entries, "original");
    expect(verified.entries).toBe(2);
    expect(verified.objects).toEqual(Object.entries(entries).map(([key, entry]) => ({ key, ...entry, bytes: readFileSync(join(directory, "objects", entry.sha256)).byteLength })));
    rmSync(path);
    expect(() => verifyRegistryInventory(directory, entries, "original")).toThrow("Missing replay object");
    writeFileSync(path, "mutable replacement");
    expect(() => verifyRegistryInventory(directory, entries, "original")).toThrow("digest mismatch");
    writeFileSync(path, bytes);
    expect(verifyRegistryInventory(directory, entries, "original").bytes).toBe(48);
  });
});

test("the staged index must retain the entire selected original inventory, status and type", () => {
  withReplay((directory, original) => {
    const metadata = original["/-/package/next/dist-tags"]!;
    for (const entries of [{ "/pkg/-/pkg.tgz": original["/pkg/-/pkg.tgz"] },
      { ...original, "/-/package/next/dist-tags": { ...metadata, status: 503 } },
      { ...original, "/-/package/next/dist-tags": { ...metadata, type: "text/plain" } },
      { ...original, "/extra": metadata }]) {
      writeFileSync(join(directory, "index.json"), JSON.stringify(entries));
      expect(() => verifyRegistryInventory(directory, original, "original")).toThrow();
    }
  });
});

test("invalid replay status, type and digest fail admission before serving", () => {
  withReplay((directory, original) => {
    const metadata = original["/-/package/next/dist-tags"]!;
    for (const bad of [{ ...metadata, status: 200.5 }, { ...metadata, type: "" }, { ...metadata, type: "application/json\r\nx-private: y" }, { ...metadata, sha256: "../index.json" }]) {
      const entries = { ...original, "/-/package/next/dist-tags": bad };
      writeFileSync(join(directory, "index.json"), JSON.stringify(entries));
      expect(() => verifyRegistryInventory(directory, entries, "original")).toThrow();
    }
  });
});


test("replay admission is pinned to all selected ORIGINAL index bytes before any app work", () => {
  withReplay((directory, entries) => {
    const paths = [join(directory, "index.json")];
    const originalIdentity = digest(readFileSync(paths[0]!));
    expect(verifyReplayAdmission(paths, originalIdentity).inventory).toMatchObject([{ entries: 2, bytes: 48, sha256: originalIdentity }]);
    expect(() => verifyReplayAdmission(paths, undefined)).toThrow("ORIGINAL");
    expect(() => verifyReplayAdmission(paths, "0".repeat(64))).toThrow("identity mismatch");
    writeFileSync(paths[0]!, JSON.stringify({ "/pkg/-/pkg.tgz": entries["/pkg/-/pkg.tgz"] }));
    expect(() => verifyReplayAdmission(paths, originalIdentity)).toThrow("identity mismatch");
  });
});

test("the full control gate requires a distinct positive class-sender request and actual overlap", () => {
  const all = phaseControlRequests.flatMap((control, index) => records(control.route).map(row => ({ ...row, probe: control.probe, requestId: index + 1 })));
  expect(() => verifyPhaseObservationControls(lines(all))).not.toThrow();
  expect(() => verifyPhaseObservationControls(lines(all.filter(row => row.probe !== "phase-class-sender")))).toThrow();
  expect(() => verifyPhaseObservationControls(lines(all.map(row => ({ ...row, requestId: 1 }))))).toThrow();
  const notOverlapping = all.map(row => row.probe === "phase-overlap-b" ? { ...row, at: row.at + 20 } : row);
  expect(() => verifyPhaseObservationControls(lines(notOverlapping))).toThrow("overlap");
  expect(phaseSenderControl.path).toBe("pages/phase-sender-control.tsx");
  expect(phaseSenderControl.source).toContain("getServerSideProps");
  expect(phaseSenderControl.source).not.toContain("next/dist");
});

test("driver source gates replay before session creation without widening engines or deadlines", () => {
  const text = readFileSync(join(import.meta.dir, "next-acceptance.ts"), "utf8");
  expect(text.indexOf("verifyReplayAdmission(registryPaths")).toBeLessThan(text.indexOf('session("bun-wasm-next01-"'));
  expect(text).toContain('values.engine !== "quickjs" && values.engine !== "jsc" && values.engine !== "browser"');
  expect(text).not.toContain('engine !== "hermes"');
  expect(text).toContain('const observerSources = phaseObservation ? applyBrowserErrorPhaseObserver(staged.files) : null;');
});

function servingAcknowledgement() {
  return { pid: 42, observer: { servingContext: true, registered: true, dropped: 0, registration: {
    nextWorker: true, runtime: "nodejs", pid: 42, moduleCacheAccess: true, provider: "module.createRequire",
    modules: [
      { label: "base-server", path: "/fixture/node_modules/next/dist/server/base-server.js", defaultConstructor: "BaseServer" },
      { label: "next-server", path: "/fixture/node_modules/next/dist/server/next-server.js", defaultConstructor: "NextNodeServer" },
      { label: "next-dev-server", path: "/fixture/node_modules/next/dist/server/dev/next-dev-server.js", defaultConstructor: "DevServer" },
    ], hooks: observerHooks.map(target => ({ target, installed: [target] })),
  } } };
}

function allControlsTerminal() {
  return lines(phaseControlRequests.flatMap((control, index) => records(control.route).map(row => ({ ...row, probe: control.probe, requestId: index + 1 }))));
}

function responseFixture(control: typeof phaseControlRequests[number]) {
  const context = { header: control.probe, cookie: control.probe, after: control.probe, cookieAfter: control.probe };
  const body = control.route === "api/context" ? JSON.stringify({ ...servingAcknowledgement(), ...context })
    : control.route === "dynamic" ? `server-original ${JSON.stringify(context).replaceAll('"', "&quot;")}`
    : control.route === "missing-acceptance" ? "NEXT-01 missing" : "NEXT phase class sender";
  return { kind: "complete", status: control.route === "missing-acceptance" ? 404 : 200, body, bytesRead: Buffer.byteLength(body), chunks: [] };
}

function controlFixture(terminal = allControlsTerminal(), mutate = (response: ReturnType<typeof responseFixture>, _control: typeof phaseControlRequests[number]) => response) {
  const text = readFileSync(join(import.meta.dir, "next-acceptance-observer-control.ts"), "utf8").replace(/^import .*\n/gm, "");
  const source = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(text).replace(/^export /gm, "");
  const requests: { page: unknown; url: string; deadline: number; headers: Record<string, string>; expectedStatus: number }[] = [];
  const writes = new Map<string, string>();
  const cookies: boolean[] = [];
  const page = { url: () => previewOrigin, evaluate: async (_fn: unknown, input: { clear: boolean }) => { cookies.push(input.clear); } };
  const run = runInNewContext(source + "\n({ runPhaseObservationControl, runObservedRecovery })", {
    assert, Date, URL, phaseControlRequests, routeCoverage, requireServingObserver, assertPreviewPageOrigin, verifyPhaseObservationControls,
    join, writeFileSync: (path: string, value: string) => { writes.set(path, value); }, terminalText: async () => terminal,
    requestProbe: async (candidate: unknown, request: typeof requests[number]) => {
      const control = phaseControlRequests.find(control => control.probe === request.headers["x-bun-writer-probe"]);
      assert.ok(control);
      requests.push({ ...request, page: candidate });
      return mutate(responseFixture(control), control);
    },
  });
  return { run: () => run.runPhaseObservationControl(page, previewOrigin, 180000, {}, "/source-fixture"), recovery: run.runObservedRecovery, requests, writes, page, cookies };
}

test("integrated diagnostic controls fetch all six tags on the admitted page, validate responses and then verify terminal coverage", async () => {
  const fixture = controlFixture();
  await fixture.run();
  expect(fixture.requests.map(request => request.headers["x-bun-writer-probe"])).toEqual(phaseControlRequests.map(control => control.probe));
  expect(new Set(fixture.requests.map(request => request.deadline)).size).toBe(1);
  expect(fixture.requests.every(request => request.page === fixture.page)).toBe(true);
  expect(fixture.requests.map(request => new URL(request.url).pathname)).toEqual(phaseControlRequests.map(control => `/${control.route}`));
  expect(fixture.requests.map(request => request.expectedStatus)).toEqual([200, 200, 404, 200, 200, 200]);
  expect(fixture.cookies).toEqual([false, true]);
  const result = JSON.parse(fixture.writes.get("/source-fixture/phase-coverage-qualified.json") ?? "null");
  expect(result.controls).toHaveLength(6);
  expect(result.invalidEditAllowed).toBe(true);
});

test("synthetic terminal coverage alone cannot satisfy the integrated gate without successful real-response checks", async () => {
  for (const mutate of [
    (response: ReturnType<typeof responseFixture>) => ({ ...response, status: 503 }),
    (response: ReturnType<typeof responseFixture>) => ({ ...response, kind: "cancelled" }),
    (response: ReturnType<typeof responseFixture>) => ({ ...response, bytesRead: 0 }),
    (response: ReturnType<typeof responseFixture>) => ({ ...response, body: "wrong body" }),
  ]) {
    const fixture = controlFixture(allControlsTerminal(), mutate);
    await expect(fixture.run()).rejects.toThrow();
    expect(fixture.writes.has("/source-fixture/phase-coverage-qualified.json")).toBe(false);
    expect(fixture.cookies).toEqual([false, true]);
  }
  const missingTerminal = controlFixture("");
  await expect(missingTerminal.run()).rejects.toThrow("Missing tagged records");
  expect(missingTerminal.requests).toHaveLength(6);
  expect(missingTerminal.writes.has("/source-fixture/phase-coverage-qualified.json")).toBe(false);
});

test("serving-worker acknowledgement refuses absent hooks, wrong public provider and a different process", () => {
  expect(() => requireServingObserver(JSON.stringify(servingAcknowledgement()))).not.toThrow();
  const missingHook = servingAcknowledgement();
  missingHook.observer.registration.hooks.pop();
  const wrongProvider = servingAcknowledgement();
  wrongProvider.observer.registration.provider = "private-require-cache";
  const wrongProcess = servingAcknowledgement();
  wrongProcess.observer.registration.pid++;
  const wrongWorker = servingAcknowledgement();
  wrongWorker.observer.servingContext = false;
  const dropped = servingAcknowledgement();
  dropped.observer.dropped++;
  for (const body of [missingHook, wrongProvider, wrongProcess, wrongWorker, dropped]) expect(() => requireServingObserver(JSON.stringify(body))).toThrow();
});

async function diagnosticBranch(failedPhase = "") {
  const text = readFileSync(join(import.meta.dir, "next-acceptance.ts"), "utf8");
  const source = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(text.slice(text.indexOf("async function serverCases("), text.indexOf("\nasync function serverPid(")));
  const events: string[] = [];
  const passedPhases = new Set<string>(["dev"]);
  const page = sourcePage();
  const run = runInNewContext(source + "\nserverCases", {
    assert, Date, output: "/source-fixture", timeout: 180000, phaseObservation: true, assertPreviewPageOrigin,
    waitForPreviewReady: async (candidate: ReturnType<typeof sourcePage>, base: string) => { await candidate.goto(base); },
    phase: async (name: string, operation: () => Promise<void>, prerequisite?: string) => {
      events.push(name);
      if (name === failedPhase || prerequisite && !passedPhases.has(prerequisite)) return false;
      await operation();
      passedPhases.add(name);
      return true;
    },
    serverPid: async (candidate: ReturnType<typeof sourcePage>) => { assertPreviewPageOrigin(candidate.url(), previewOrigin); return 42; },
    runPhaseObservationControl: async (candidate: ReturnType<typeof sourcePage>) => { assertPreviewPageOrigin(candidate.url(), previewOrigin); events.push("verified-real-controls"); },
    runObservedRecovery: async (_page: unknown, tag: string, operation: () => Promise<void>) => { events.push(tag); await operation(); },
    compileErrorRecovery: async () => { events.push("invalid-edit"); }, runRouteCase: async () => { events.push("application-error-route"); },
  });
  await run({}, page, previewOrigin, "dev", {}, {});
  return events;
}

test("the actual driver requires process and all controls before any invalid edit, without broad warmup or fallback", async () => {
  const passed = await diagnosticBranch();
  expect(passed.indexOf("verified-real-controls")).toBeLessThan(passed.indexOf("invalid-edit"));
  for (const phase of ["dev:http-ready", "dev:process", "dev:phase-observer-control"]) expect(await diagnosticBranch(phase)).not.toContain("invalid-edit");
  expect(await diagnosticBranch("dev:compile-recovery")).not.toContain("application-error-route");
  expect(passed).not.toContain("dev:warm");
});


test("every control response needs its own expected body and status before qualification", async () => {
  for (const selected of phaseControlRequests) {
    const wrongBody = controlFixture(allControlsTerminal(), (response, control) => control.probe === selected.probe ? { ...response, body: "wrong body" } : response);
    await expect(wrongBody.run()).rejects.toThrow();
    expect(wrongBody.writes.has("/source-fixture/phase-coverage-qualified.json")).toBe(false);
    const wrongStatus = controlFixture(allControlsTerminal(), (response, control) => control.probe === selected.probe ? { ...response, status: 503 } : response);
    await expect(wrongStatus.run()).rejects.toThrow();
    expect(wrongStatus.writes.has("/source-fixture/phase-coverage-qualified.json")).toBe(false);
  }
  const blank = controlFixture();
  blank.page.url = () => "about:blank";
  await expect(blank.run()).rejects.toThrow();
  expect(blank.requests).toHaveLength(0);
  expect(blank.cookies).toEqual([]);
});


test("recovery header tags are removed after success and failure without changing the existing operation", async () => {
  const fixture = controlFixture();
  const headers: Record<string, string>[] = [];
  const page = { setExtraHTTPHeaders: async (value: Record<string, string>) => { headers.push(value); } };
  let called = 0;
  await fixture.recovery(page, "compile-error", async () => { called++; });
  await expect(fixture.recovery(page, "application-error", async () => { throw new Error("recovery failed"); })).rejects.toThrow("recovery failed");
  expect(called).toBe(1);
  expect(headers).toEqual([{ "x-bun-error-phase-probe": "compile-error" }, {}, { "x-bun-error-phase-probe": "application-error" }, {}]);
});
