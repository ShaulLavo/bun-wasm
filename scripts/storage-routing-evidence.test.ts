import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StorageRoutingEvidence, type RoutingRow } from "./storage-routing-evidence";
import { discoverChecks } from "./test-checks";
import { needsRust } from "./ci-changes";
import { verifyRoutingInstallation, routingObservationSource } from "./storage-routing-build";
import release from "./waffle-release-inputs.json";

const target = "/src/main.ts";
const url = "http://localhost/__preview/5173/src/main.ts";
function fixture() {
  const evidence = new StorageRoutingEvidence();
  const sequences = new Map<string, number>();
  const row = (kind: string, extra: RoutingRow = {}) => {
    const generation = String(extra.generation ?? "sw");
    const sequence = (sequences.get(generation) ?? 0) + 1;
    sequences.set(generation, sequence);
    evidence.receive({ kind, target, port: 5173, generation, realm: "worker", sequence, ask: 1, channel: 3, clientURL: "http://localhost/app", ...(kind === "claim-reply" && extra.reply === "head" ? { status: 200 } : {}), ...extra });
  };
  const page = (kind: string, extra: RoutingRow = {}) => row(kind, { generation: "page", realm: "page", realmURL: "http://localhost/app", router: 4, replyPort: 5, request: 7, ...extra });
  const native = () => evidence.request({ kind: "request", url, page: 1, request: 1, navigation: true, frame: 1 });
  const first = () => JSON.stringify(evidence.summaries()[1]);
  return { evidence, row, page, native, first };
}
function forward(f: ReturnType<typeof fixture>, drop?: Drop) { f.native(); if (drop !== "forward") f.row("forward", { url }); }
function claim(f: ReturnType<typeof fixture>, drop?: Drop) {
  forward(f, drop); f.row("discovery"); f.row("claim-open"); f.row("claim-post"); f.row("claim-post-return");
}
function accepted(f: ReturnType<typeof fixture>) {
  claim(f); f.page("page-receive"); f.page("request-dispatch", { current: 11 });
  f.row("runtime-router", { generation: "page", router: 4, runtime: 2 });
  f.row("helper-projection", { generation: "page", capability: 11, helper: 12 });
  f.page("helper-request-return", { helper: 12, accepted: true });
}

test("first incomplete hop and explicit outcomes do not infer a guest or filesystem cause", () => {
  const f = fixture();
  expect(f.first()).toContain("No observed browser request");
  f.native(); expect(f.first()).toContain("no SW event observed");
  f.row("forward", { url }); expect(f.first()).toContain("discovery or claim completion missing");
  f.row("claim-open"); expect(f.first()).toContain("send call not observed");
  f.row("claim-post"); expect(f.first()).toContain("return not observed");
  f.row("claim-post-return"); expect(f.first()).toContain("actual page receipt not observed");
  f.page("page-receive"); expect(f.first()).toContain("registered-server dispatch not observed");
  f.page("request-dispatch", { current: 11 }); expect(f.first()).toContain("real helper.request return missing or ambiguous");
  f.row("helper-projection", { generation: "page", capability: 11, helper: 12 });
  f.page("helper-request-return", { helper: 12, accepted: true }); expect(f.first()).toContain("page acceptance send return not observed");
  f.page("page-send", { reply: "accepted" }); expect(f.first()).toContain("page acceptance send return not observed");
  f.page("page-send-return", { reply: "accepted" }); expect(f.first()).toContain("SW receipt not observed");
  f.row("claim-reply", { reply: "accepted" }); expect(f.first()).toContain("Accepted by SW; no response headers observed");
  f.row("claim-reply", { reply: "head" }); expect(f.first()).toContain("body completion not observed");
  f.row("claim-reply", { reply: "end" }); expect(f.first()).toContain("Routing body completed");
  f.row("claim-reply", { reply: "error", error: "server closed" }); expect(f.first()).toContain("SW received explicit server error");
});

for (const kind of ["claim-post-failure", "claim-timeout"]) test(`unavailable preserves explicit ${kind}`, () => {
  const f = fixture(); claim(f); f.row(kind); f.row("unavailable");
  expect(f.first()).toContain(kind);
  expect(f.first()).toContain("All observed candidates refused, expired or failed to post");
});

test("no eligible discovery, explicit refusal and exact helper error are distinct", () => {
  const absent = fixture(); forward(absent); absent.row("discovery", { clients: 0 }); absent.row("unavailable");
  expect(absent.first()).toContain("without an eligible candidate");
  const denied = fixture(); claim(denied); denied.page("page-receive"); denied.page("request-dispatch", { current: null });
  expect(denied.first()).toContain("without a registered server");
  const failed = fixture(); accepted(failed); failed.page("helper-request-error", { helper: 12, error: "original helper error" });
  expect(failed.first()).toContain("Real helper.request threw"); expect(failed.first()).toContain("original helper error");
});

test("repeated native/SW targets and page receipts never join by clocks or local IDs", () => {
  const f = fixture(); claim(f); f.page("page-receive"); f.page("page-receive");
  expect(f.first()).toContain("ambiguous page receipt join");
  f.row("forward", { url, ask: 2 }); expect(f.first()).toContain("ambiguous same-target");
});

test("positive qualification needs native completion and real runtime/helper plus SW head and end", () => {
  const f = fixture(); accepted(f);
  expect(() => f.evidence.qualify([target])).toThrow("coverage missing");
  f.page("page-send-return", { reply: "head" }); f.row("claim-reply", { reply: "head" }); f.row("claim-reply", { reply: "end" });
  expect(() => f.evidence.qualify([target])).toThrow("coverage missing");
  f.evidence.request({ kind: "response", url, page: 1, request: 1, status: 200, fromServiceWorker: true });
  f.evidence.request({ kind: "requestfinished", url, page: 1, request: 1 });
  expect(() => f.evidence.qualify([target])).not.toThrow();
});

test("bounded scalar retention rejects payloads, exposes drops and de-duplicates cross-page transport", () => {
  const f = fixture();
  expect(() => f.evidence.receive({ kind: "bad", body: new Uint8Array([123]) })).toThrow("non-scalar");
  f.evidence.receive({ kind: "same", generation: "realm", sequence: 1 });
  f.evidence.receive({ kind: "same", generation: "realm", sequence: 1 });
  expect(f.evidence.rows).toHaveLength(1);
  forward(f);
  for (let i = 0; i < 4200; i++) f.row("noise");
  expect(f.evidence.rows).toHaveLength(4096);
  expect(f.evidence.snapshot().dropped).toBe(106);
  expect(f.first()).toContain("overflow");
});

test("restart scopes exclude old traffic while delayed metadata remains available", () => {
  const f = fixture(); forward(f); f.evidence.beginRestart();
  expect(f.first()).toContain("No observed browser request");
  claim(f); expect(f.first()).toContain("actual page receipt not observed");
  f.page("page-receive"); expect(f.first()).toContain("registered-server dispatch not observed");
});

test("selected installed package and each unique consumer anchor fail closed, and helper edits select ordinary storage", () => {
  verifyRoutingInstallation(resolve(import.meta.dir, "../sandbox/node_modules/waffle"));
  for (const file of ["sandbox/src/sandbox.ts", "web/src/preview.ts"]) {
    const path = resolve(import.meta.dir, "..", file);
    expect(routingObservationSource(path, readFileSync(path, "utf8"))).toContain("__trace");
    expect(() => routingObservationSource(path, "missing anchor")).toThrow();
  }
  const storage = discoverChecks().find(check => check.path === "scripts/sandbox-storage-browser.test.ts");
  for (const file of ["storage-routing-build.ts", "storage-routing-build-source.ts", "storage-routing-collector.ts", "storage-routing-evidence.ts"]) {
    expect(storage?.inputs).toContain(`scripts/${file}`);
    expect(needsRust([`scripts/${file}`])).toBe(true);
  }
});

test("routing installation rejects a wrong version and every modified qualified source", () => {
  const installed = resolve(import.meta.dir, "../sandbox/node_modules/waffle");
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-routing-gate-"));
  const files = ["browser/service-worker.ts", "browser/preview.ts", "browser/net/helper.ts", "browser/net/runtime.ts"];
  try {
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(installed, file), join(root, file));
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: release.version }));
    expect(() => verifyRoutingInstallation(root)).not.toThrow();
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.136" }));
    expect(() => verifyRoutingInstallation(root)).toThrow(`Waffle ${release.version}`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: release.version }));
    for (const file of files) {
      writeFileSync(join(root, file), readFileSync(join(installed, file), "utf8") + "\n");
      expect(() => verifyRoutingInstallation(root)).toThrow(file);
      copyFileSync(join(installed, file), join(root, file));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default builds omit routing diagnostics", async () => {
  const { browserBuildConfig } = await import("./browser-build");
  const previous = process.env.BUN_WASM_STORAGE_DIAGNOSTICS;
  delete process.env.BUN_WASM_STORAGE_DIAGNOSTICS;
  try {
    const config = browserBuildConfig([resolve(import.meta.dir, "../sandbox/src/main.ts")], "/work/tmp/unused-routing");
    expect(config.plugins?.some(plugin => plugin.name === "storage-first-event")).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.BUN_WASM_STORAGE_DIAGNOSTICS;
    else process.env.BUN_WASM_STORAGE_DIAGNOSTICS = previous;
  }
});

test("missing scalar stream coverage refuses attribution and qualification", () => {
  const f = fixture(); accepted(f);
  f.evidence.receive({ kind: "late", generation: "missing", sequence: 3 });
  expect(f.first()).toContain("routing stream coverage is missing");
  const coverage = f.evidence.snapshot().coverage.find(stream => stream.generation === "missing");
  expect(coverage?.missing).toBe(2);
});

// A routing record that `complete` leaves out, to prove the check needs it.
type Drop = "forward" | "head" | "end";
function complete(f: ReturnType<typeof fixture>, receipt: RoutingRow = {}, sent: RoutingRow = {}, drop?: Drop) {
  claim(f, drop);
  f.page("page-receive", receipt);
  f.page("request-dispatch", { current: 11 });
  f.page("runtime-router", { runtime: 2 });
  f.page("helper-projection", { capability: 11, helper: 12 });
  f.page("helper-request-return", { helper: 12, accepted: true });
  f.page("page-send-return", { reply: "head", ...sent });
  if (drop !== "head") f.row("claim-reply", { reply: "head" });
  if (drop !== "end") f.row("claim-reply", { reply: "end" });
}

test("native response and completion must belong to the same page and request", () => {
  for (const mismatch of [{ page: 1, request: 2 }, { page: 2, request: 1 }]) {
    const f = fixture();
    complete(f);
    f.evidence.request({ kind: "response", page: 1, request: 1, url, status: 200, fromServiceWorker: true });
    f.evidence.request({ kind: "requestfinished", url, ...mismatch });
    expect(() => f.evidence.qualify([target])).toThrow();
  }
});

test("page receipt and head send cannot borrow another generation or reply port", () => {
  const mismatches: readonly RoutingRow[] = [{ generation: "old-page" }, { replyPort: 99 }];
  for (const mismatch of mismatches) {
    const receipt = fixture();
    complete(receipt, mismatch);
    receipt.evidence.request({ kind: "response", page: 1, request: 1, url, status: 200, fromServiceWorker: true });
    receipt.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
    expect(() => receipt.evidence.qualify([target])).toThrow();
    const sent = fixture();
    complete(sent, {}, mismatch);
    sent.evidence.request({ kind: "response", page: 1, request: 1, url, status: 200, fromServiceWorker: true });
    sent.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
    expect(() => sent.evidence.qualify([target])).toThrow();
  }
});

test("a loading redirect is distinct from the completed native response matching the real guest head", () => {
  const f = fixture();
  complete(f);
  f.evidence.request({ kind: "response", page: 1, request: 1, url, status: 307, fromServiceWorker: true, loadingNavigation: true });
  f.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
  f.evidence.request({ kind: "request", page: 1, request: 2, url });
  f.evidence.request({ kind: "response", page: 1, request: 2, url, status: 200, fromServiceWorker: true });
  f.evidence.request({ kind: "requestfinished", page: 1, request: 2, url });
  expect(() => f.evidence.qualify([target])).not.toThrow();
});

const loadingUrl = "http://localhost/__preview/.loading/123e4567-e89b-12d3-a456-426614174000";
type Abort = {
  errorText?: string; navigation?: boolean; extraAbort?: boolean; drop?: Drop;
  loading?: "complete" | "unfinished" | "other-preview" | "missing" | "late" | "late-response";
  loadingFrame?: number; matchFrame?: number; matchNavigation?: boolean;
};
// Firefox reports the first navigation as aborted and then navigates to the loading page itself.
// The fixture's own native request 1 (frame 1) is the aborted navigation.
function abortedThenCompleted(abort: Abort): ReturnType<typeof fixture> {
  const f = fixture();
  complete(f, {}, {}, abort.drop);
  const request = (row: RoutingRow) => f.evidence.request(row);
  const loading = abort.loading ?? "complete";
  const address = loading === "other-preview" ? "http://localhost/other/__preview/.loading/123e4567-e89b-12d3-a456-426614174000" : loadingUrl;
  const loadingFrame = abort.loadingFrame ?? 1;
  const loadingStart = () => request({ kind: "request", page: 1, request: 2, url: address, navigation: true, frame: loadingFrame });
  const loadingEnd = () => {
    request({ kind: "response", page: 1, request: 2, url: address, status: 200, fromServiceWorker: false, navigation: true, frame: loadingFrame });
    if (loading !== "unfinished") request({ kind: "requestfinished", page: 1, request: 2, url: address, navigation: true, frame: loadingFrame });
  };
  request({ kind: "requestfailed", page: 1, request: 1, url, navigation: abort.navigation ?? true, frame: 1, errorText: abort.errorText ?? "NS_BINDING_ABORTED" });
  if (abort.extraAbort) {
    request({ kind: "request", page: 1, request: 4, url, navigation: true, frame: 1 });
    request({ kind: "requestfailed", page: 1, request: 4, url, navigation: true, frame: 1, errorText: "NS_BINDING_ABORTED" });
  }
  if (loading !== "missing" && loading !== "late") { loadingStart(); if (loading !== "late-response") loadingEnd(); }
  request({ kind: "request", page: 1, request: 3, url, navigation: abort.matchNavigation ?? true, frame: abort.matchFrame ?? 1 });
  if (loading === "late") loadingStart();
  if (loading === "late" || loading === "late-response") loadingEnd();
  request({ kind: "response", page: 1, request: 3, url, status: 200, fromServiceWorker: true, navigation: abort.matchNavigation ?? true, frame: abort.matchFrame ?? 1 });
  request({ kind: "requestfinished", page: 1, request: 3, url, navigation: abort.matchNavigation ?? true, frame: abort.matchFrame ?? 1 });
  return f;
}

test("an aborted navigation followed by the loading page is the loading redirect", () => {
  expect(() => abortedThenCompleted({}).evidence.qualify([target])).not.toThrow();
});

test("an aborted navigation without a finished loading page in this preview stays a routing failure", () => {
  for (const abort of [{ errorText: "NS_ERROR_NET_RESET" }, { navigation: false }, { loading: "missing" }, { loading: "late" }, { loading: "unfinished" }, { loading: "other-preview" }, { extraAbort: true }] as Abort[]) {
    expect(() => abortedThenCompleted(abort).evidence.qualify([target])).toThrow("coverage missing");
  }
});

test("the loading redirect needs the loading page to answer before the retry starts", () => {
  expect(() => abortedThenCompleted({ loading: "late-response" }).evidence.qualify([target])).toThrow("coverage missing");
});

test("the loading redirect needs all three navigations in one frame", () => {
  for (const abort of [{ loadingFrame: 2 }, { matchFrame: 2 }, { matchNavigation: false }] as Abort[]) {
    expect(() => abortedThenCompleted(abort).evidence.qualify([target])).toThrow("coverage missing");
  }
});

test("the loading redirect does not stand in for a missing service worker forward, head or end", () => {
  expect(() => abortedThenCompleted({ drop: "forward" }).evidence.qualify([target])).toThrow("missing SW forward");
  for (const drop of ["head", "end"] as const) expect(() => abortedThenCompleted({ drop }).evidence.qualify([target])).toThrow("coverage missing");
});

test("native completion rejects a different status and duplicate matching response lifecycles", () => {
  const wrong = fixture();
  complete(wrong);
  wrong.evidence.request({ kind: "response", page: 1, request: 1, url, status: 502, fromServiceWorker: true });
  wrong.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
  expect(() => wrong.evidence.qualify([target])).toThrow();
  const repeated = fixture();
  complete(repeated);
  for (const request of [1, 2]) {
    repeated.evidence.request({ kind: "request", page: 1, request, url });
    repeated.evidence.request({ kind: "response", page: 1, request, url, status: 200, fromServiceWorker: true });
    repeated.evidence.request({ kind: "requestfinished", page: 1, request, url });
  }
  expect(() => repeated.evidence.qualify([target])).toThrow();
});

test("a completed response cannot hide an extra error, network response or unmarked redirect", () => {
  for (const extra of [{ status: 502, fromServiceWorker: true }, { status: 200, fromServiceWorker: false }, { status: 307, fromServiceWorker: true }]) {
    const f = fixture();
    complete(f);
    f.evidence.request({ kind: "response", page: 1, request: 1, url, status: 200, fromServiceWorker: true });
    f.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
    f.evidence.request({ kind: "request", page: 1, request: 2, url });
    f.evidence.request({ kind: "response", page: 1, request: 2, url, ...extra });
    f.evidence.request({ kind: "requestfinished", page: 1, request: 2, url });
    expect(() => f.evidence.qualify([target])).toThrow();
  }
});

test("a current page receipt cannot borrow stale helper or acceptance evidence", () => {
  const f = fixture();
  claim(f);
  f.page("page-receive", { generation: "new-page" });
  f.page("request-dispatch", { current: 11 });
  f.page("helper-projection", { capability: 11, helper: 12 });
  f.page("helper-request-return", { helper: 12, accepted: true });
  f.page("page-send-return", { reply: "accepted" });
  expect(f.first()).toContain("registered-server dispatch not observed");
});

test("restart fetch evidence excludes the previous observation window", () => {
  const f = fixture();
  f.row("sw-fetch", { url });
  f.evidence.beginRestart();
  f.native();
  expect(f.first()).toContain("no SW event observed");
  f.row("sw-fetch", { url });
  expect(f.first()).toContain("SW fetch observed; forward not observed");
  f.row("sw-fetch", { url });
  expect(f.first()).toContain("ambiguous browser/SW fetch join");
});
