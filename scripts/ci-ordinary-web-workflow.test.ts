import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { record } from "./guest-core-receipt.ts";
import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const source = expandedCiWorkflow();
const workflow: unknown = Bun.YAML.parse(source);
if (!record(workflow) || !record(workflow.jobs)) throw new Error("Missing workflow jobs");
const jobs = workflow.jobs;
function job(id: string) {
  const value = jobs[id];
  if (!record(value)) throw new Error(`Missing job ${id}`);
  return value;
}
function steps(id: string) {
  const value = job(id).steps;
  if (!Array.isArray(value)) throw new Error("Missing steps");
  return value.map(step => { if (!record(step)) throw new Error("Invalid step"); return step; });
}
function named(id: string, name: string) {
  const value = steps(id).find(step => step.name === name);
  if (!value) throw new Error(`Missing step ${name}`);
  return value;
}

type Route = { full: boolean; native: boolean; outcome: string; shared?: string; browser?: boolean; event?: string; draft?: boolean; cancelled?: boolean };
function admission(id: string, route: Route): boolean {
  const value = job(id);
  if (typeof value.if !== "string") throw new Error("Missing explicit admission");
  const needs = typeof value.needs === "string" ? [value.needs] : Array.isArray(value.needs) ? value.needs : [];
  const browser = route.browser ?? route.full;
  const outcomes: Record<string, string> = {
    "ordinary-build": route.full || browser ? route.outcome : "skipped",
    "shared-sysroot": route.shared ?? (route.native ? "success" : "skipped"),
    "web-browser": "success",
  };
  const expression = value.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event_name", JSON.stringify(route.event ?? "pull_request")).replaceAll("github.event.pull_request.draft", String(route.draft ?? false))
    .replace(/needs\.selection\.outputs\.([\w-]+)/g, (_all, flag: string) => JSON.stringify(String(flag === "rust" ? route.full : flag === "browser_guest" ? browser : flag === "shared-native" ? route.native : true)))
    .replace(/needs\.([\w-]+)\.result/g, (_all, dependency: string) => JSON.stringify(outcomes[dependency] ?? "success"))
    .replaceAll("always()", "true").replaceAll("cancelled()", String(route.cancelled ?? false));
  const implicit = /always\(\)|cancelled\(\)|success\(\)|failure\(\)/.test(value.if) || (!route.cancelled && needs.every(dep => typeof dep === "string" && (outcomes[dep] ?? "success") === "success"));
  return implicit && new Function(`return (${expression})`)() === true;
}

test("ordinary-build gates runtime, fixtures, browser-guest and shared-consumers across routes", () => {
  for (const id of ["rust", "rust-fixtures", "browser-guest", "shared-consumers", "ci-result", "update-status"]) expect(job(id).needs).toContain("ordinary-build");
  for (const outcome of ["failure", "cancelled", "skipped"]) {
    for (const id of ["rust", "rust-fixtures", "browser-guest", "shared-consumers"]) expect(admission(id, { full: true, native: true, outcome }), `${id}: ${outcome}`).toBe(false);
    expect(admission("shared-sysroot", { full: true, native: true, outcome })).toBe(true);
  }
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const id of ["ordinary-build", "rust", "rust-fixtures", "shared-sysroot", "shared-consumers", "browser-guest"]) expect(admission(id, { full: true, native: true, outcome: "success", event }), id).toBe(true);
  }
  expect(admission("shared-sysroot", { full: false, native: false, outcome: "skipped" })).toBe(true);
  expect(admission("shared-consumers", { full: false, native: false, outcome: "skipped" })).toBe(false);
  expect(admission("rust", { full: false, native: false, outcome: "skipped" })).toBe(false);
  expect(admission("rust-fixtures", { full: false, native: false, outcome: "skipped" })).toBe(false);
  expect(admission("browser-guest", { full: false, native: false, outcome: "skipped" })).toBe(false);
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    const route = { full: false, browser: true, native: false, outcome: "success", event };
    expect(admission("ordinary-build", route)).toBe(true);
    expect(admission("rust", route)).toBe(event !== "pull_request");
    expect(admission("rust-fixtures", route)).toBe(event !== "pull_request");
    expect(admission("browser-guest", route)).toBe(true);
  }
  for (const id of ["ordinary-build", "rust", "rust-fixtures", "shared-sysroot", "shared-consumers", "browser-guest"]) {
    expect(admission(id, { full: true, native: true, outcome: "success", draft: true })).toBe(false);
    expect(admission(id, { full: true, native: true, outcome: "success", cancelled: true })).toBe(false);
  }
});

test("ordinary runtime checks still run when shared production fails, while shared consumers require shared-sysroot", () => {
  const route = { full: true, native: true, outcome: "success" };
  for (const result of ["failure", "cancelled", "skipped"]) {
    expect(admission("rust", { ...route, shared: result })).toBe(true);
    expect(admission("rust-fixtures", { ...route, shared: result })).toBe(true);
    expect(admission("shared-consumers", { ...route, shared: result })).toBe(false);
  }
});

test("ordinary-build produces the launcher once and runtime/fixtures download verified deliveries with five-minute caps", () => {
  const upload = steps("ordinary-build").filter(step => record(step.with) && step.with.name === "native-profile-launcher");
  expect(upload).toHaveLength(1);
  expect(upload[0]?.["timeout-minutes"]).toBe(5);
  const runtimeDownloads = steps("rust").filter(step => step.uses === "actions/download-artifact@v4");
  expect(runtimeDownloads).toHaveLength(5);
  for (const download of runtimeDownloads) {
    expect(download["timeout-minutes"]).toBe(5);
    if (!record(download.with)) throw new Error("Missing artifact");
    expect(download.if).toBe(download.with.name === "ordinary-jsc-program" ? "needs.selection.outputs.jsc == 'true'" : undefined);
  }
  expect(job("ordinary-build")["runs-on"]).toBe(job("rust")["runs-on"]);
  expect(job("ordinary-build")["timeout-minutes"]).toBe(60);
  expect(job("rust")["timeout-minutes"]).toBe(30);
  expect(job("rust-fixtures")["timeout-minutes"]).toBe(25);
  expect(JSON.stringify(job("rust-fixtures"))).not.toMatch(/cargo build|rustup|build-bun|save-rust-build-cache|save-release-downloads/);
});

test("ordinary Web guest fixtures execute once per route and final cache seeds keep producer qualification", () => {
  const producer = steps("ordinary-build");
  const consumer = steps("rust");
  expect(named("ordinary-build", "Verify JSC embedding source and native backing").run).toBe("bun scripts/jsc-embedding.ts verify dist/bun-jsc.wasm");
  for (const name of ["Blocking JSC embedding and allocation checks", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)"]) {
    expect(consumer.filter(step => step.name === name)).toHaveLength(1);
  }
  // Browser-only PRs execute the Web guest checks inline inside ordinary-build when full != 'true'.
  expect(named("ordinary-build", "Blocking Web guest cases (QuickJS and host engine)").if).toContain("!= 'true'");
  expect(named("ordinary-build", "Blocking Web guest case (JSC)").if).toContain("!= 'true'");
  const exportIndex = producer.indexOf(named("ordinary-build", "Export the validated standard Browser and tools guests"));
  for (const action of ["save-rust-build-cache", "save-release-downloads"]) {
    const save = producer.findIndex(step => step.uses === `./.github/actions/${action}`);
    expect(save).toBeGreaterThan(exportIndex);
    expect(producer[save]?.if).toBeUndefined();
    const inner = readFileSync(new URL(`../.github/actions/${action}/action.yml`, import.meta.url), "utf8");
    expect(inner).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(inner).not.toContain("ordinary-web-guests");
  }
  expect(job("ci-result").if).toBe("${{ always() }}");
  expect(named("update-status", "Report each required result on the tested commit").run).toContain("Code quality|ci-result|");
});
