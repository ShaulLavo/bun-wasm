import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StorageRoutingEvidence, type RoutingRow } from "./storage-routing-evidence";
import { discoverChecks } from "./test-checks";
import { needsRust } from "./ci-changes";
import { verifyRoutingInstallation, routingObservationSource } from "./storage-routing-build";

const target = "/src/main.ts";
const url = "http://localhost/__preview/5173/src/main.ts";
function fixture() {
  const evidence = new StorageRoutingEvidence();
  const sequences = new Map<string, number>();
  const row = (kind: string, extra: RoutingRow = {}) => {
    const generation = String(extra.generation ?? "sw");
    const sequence = (sequences.get(generation) ?? 0) + 1;
    sequences.set(generation, sequence);
    evidence.receive({ kind, target, port: 5173, generation, realm: "worker", sequence, ask: 1, channel: 3, clientURL: "http://localhost/app", ...extra });
  };
  const page = (kind: string, extra: RoutingRow = {}) => row(kind, { generation: "page", realm: "page", realmURL: "http://localhost/app", router: 4, replyPort: 5, request: 7, ...extra });
  const native = () => evidence.request({ kind: "request", url, page: 1, request: 1 });
  const first = () => JSON.stringify(evidence.summaries()[1]);
  return { evidence, row, page, native, first };
}
function forward(f: ReturnType<typeof fixture>) { f.native(); f.row("forward", { url }); }
function claim(f: ReturnType<typeof fixture>) {
  forward(f); f.row("discovery"); f.row("claim-open"); f.row("claim-post"); f.row("claim-post-return");
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
  f.evidence.request({ kind: "response", url, page: 1, request: 1, fromServiceWorker: true });
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

test("installed .136 and each unique consumer anchor fail closed, and helper edits select ordinary storage", () => {
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

function complete(f: ReturnType<typeof fixture>, receipt: RoutingRow = {}, sent: RoutingRow = {}) {
  claim(f);
  f.page("page-receive", receipt);
  f.page("request-dispatch", { current: 11 });
  f.page("runtime-router", { runtime: 2 });
  f.page("helper-projection", { capability: 11, helper: 12 });
  f.page("helper-request-return", { helper: 12, accepted: true });
  f.page("page-send-return", { reply: "head", ...sent });
  f.row("claim-reply", { reply: "head" });
  f.row("claim-reply", { reply: "end" });
}

test("native response and completion must belong to the same page and request", () => {
  for (const mismatch of [{ page: 1, request: 2 }, { page: 2, request: 1 }]) {
    const f = fixture();
    complete(f);
    f.evidence.request({ kind: "response", page: 1, request: 1, url, fromServiceWorker: true });
    f.evidence.request({ kind: "requestfinished", url, ...mismatch });
    expect(() => f.evidence.qualify([target])).toThrow();
  }
});

test("page receipt and head send cannot borrow another generation or reply port", () => {
  const mismatches: readonly RoutingRow[] = [{ generation: "old-page" }, { replyPort: 99 }];
  for (const mismatch of mismatches) {
    const receipt = fixture();
    complete(receipt, mismatch);
    receipt.evidence.request({ kind: "response", page: 1, request: 1, url, fromServiceWorker: true });
    receipt.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
    expect(() => receipt.evidence.qualify([target])).toThrow();
    const sent = fixture();
    complete(sent, {}, mismatch);
    sent.evidence.request({ kind: "response", page: 1, request: 1, url, fromServiceWorker: true });
    sent.evidence.request({ kind: "requestfinished", page: 1, request: 1, url });
    expect(() => sent.evidence.qualify([target])).toThrow();
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
