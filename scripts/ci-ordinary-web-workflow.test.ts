import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { record } from "./guest-core-receipt.ts";

const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
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

type Route = { full: boolean; native: boolean; outcome: string; event?: string; draft?: boolean; cancelled?: boolean };
function admission(id: string, route: Route): boolean {
  const value = job(id);
  if (!Array.isArray(value.needs) || typeof value.if !== "string") throw new Error("Missing explicit dependencies/admission");
  const outcomes: Record<string, string> = { rust: route.full ? "success" : "skipped", "ordinary-web-guests": route.full ? route.outcome : "skipped", "browser-guest": route.full ? "success" : "skipped" };
  const expression = value.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("github.event_name", JSON.stringify(route.event ?? "pull_request")).replaceAll("github.event.pull_request.draft", String(route.draft ?? false))
    .replace(/needs\.selection\.outputs\.([\w-]+)/g, (_all, flag: string) => JSON.stringify(String(flag === "rust" ? route.full : flag === "shared-native" ? route.native : true)))
    .replace(/needs\.([\w-]+)\.result/g, (_all, dependency: string) => JSON.stringify(outcomes[dependency] ?? "success"))
    .replaceAll("always()", "true").replaceAll("cancelled()", String(route.cancelled ?? false));
  const implicit = /always\(\)|cancelled\(\)|success\(\)|failure\(\)/.test(value.if) || value.needs.every(id => typeof id === "string" && (outcomes[id] ?? "success") === "success");
  return implicit && new Function(`return (${expression})`)() === true;
}

test("all seven existing direct consumers retain the independent full-route gate", () => {
  for (const id of ["shared-sysroot", "shared-native", "shared-proof", "browser-guest", "browser-process", "ci-result", "update-status"]) expect(job(id).needs).toContain("ordinary-web-guests");
  for (const outcome of ["failure", "cancelled", "skipped", "", "missing"]) {
    for (const id of ["shared-sysroot", "shared-native", "browser-guest", "browser-process"]) expect(admission(id, { full: true, native: true, outcome }), `${id}: ${outcome}`).toBe(false);
  }
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const id of ["ordinary-web-guests", "shared-sysroot", "shared-native", "browser-guest", "browser-process"]) expect(admission(id, { full: true, native: true, outcome: "success", event }), id).toBe(true);
  }
  expect(admission("browser-process", { full: false, native: false, outcome: "skipped" })).toBe(true);
  expect(admission("shared-sysroot", { full: false, native: false, outcome: "skipped" })).toBe(true);
  expect(admission("ordinary-web-guests", { full: false, native: false, outcome: "skipped" })).toBe(false);
  expect(admission("browser-guest", { full: false, native: false, outcome: "skipped" })).toBe(false);
  for (const id of ["ordinary-web-guests", "shared-sysroot", "shared-native", "browser-guest", "browser-process"]) {
    expect(admission(id, { full: true, native: true, outcome: "success", draft: true })).toBe(false);
    expect(admission(id, { full: true, native: true, outcome: "success", cancelled: true })).toBe(false);
  }
});

test("real admission guard rejects unknown events and malformed or unselected inputs", () => {
  const guard = named("ordinary-web-guests", "Require the selected full producer");
  if (typeof guard.run !== "string") throw new Error("Missing guard body");
  const body = guard.run;
  const invoke = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-euo", "pipefail", "-c", body], { env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", FULL_SELECTED: "true", JSC_SELECTED: "true", RUST_RESULT: "success", ...env } }).status;
  for (const event of ["pull_request", "push", "workflow_dispatch"]) for (const jsc of ["true", "false"]) expect(invoke({ GITHUB_EVENT_NAME: event, JSC_SELECTED: jsc })).toBe(0);
  for (const env of [{ GITHUB_EVENT_NAME: "schedule" }, { JSC_SELECTED: "yes" }, { FULL_SELECTED: "false" }, { RUST_RESULT: "skipped" }, { RUST_RESULT: "failure" }, { RUST_RESULT: "cancelled" }, { RUST_RESULT: "" }]) expect(invoke(env)).not.toBe(0);
});

test("the launcher is produced once for JSC or shared native and consumer transfer caps stay unchanged", () => {
  const packaging = named("rust", "Package the native profile launcher");
  expect(packaging.if).toBe("needs.selection.outputs.jsc == 'true' || needs.selection.outputs.shared-native == 'true'");
  const upload = steps("rust").filter(step => record(step.with) && step.with.name === "native-profile-launcher");
  expect(upload).toHaveLength(1);
  expect(upload[0]?.if).toBe(packaging.if);
  const downloads = steps("ordinary-web-guests").filter(step => step.uses === "actions/download-artifact@v4");
  expect(downloads).toHaveLength(3);
  for (const download of downloads) {
    expect(download["timeout-minutes"]).toBe(5);
    if (!record(download.with)) throw new Error("Missing artifact");
    expect(download.if).toBe(download.with.name === "browser-program" ? undefined : "needs.selection.outputs.jsc == 'true'");
  }
  expect(job("ordinary-web-guests")["runs-on"]).toBe(job("rust")["runs-on"]);
  expect(job("ordinary-web-guests")["timeout-minutes"]).toBe(20);
  expect(job("rust")["timeout-minutes"]).toBe(60);
  expect(JSON.stringify(job("ordinary-web-guests"))).not.toMatch(/cargo build|rustup|build-bun|save-rust-build-cache|save-release-downloads|wasmtime.*install/);
});

test("moved fixtures execute once after native backing verification, and final cache seeds keep producer qualification", () => {
  const rust = steps("rust");
  const consumer = steps("ordinary-web-guests");
  expect(named("rust", "Verify JSC embedding source and native backing").run).toBe("bun scripts/jsc-embedding.ts verify dist/bun-jsc.wasm");
  for (const name of ["Blocking JSC embedding and allocation checks", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)"]) {
    expect(rust.some(step => step.name === name)).toBe(false);
    expect(consumer.filter(step => step.name === name)).toHaveLength(1);
  }
  const exportIndex = rust.indexOf(named("rust", "Export the validated standard Browser and tools guests"));
  for (const action of ["save-rust-build-cache", "save-release-downloads"]) {
    const save = rust.findIndex(step => step.uses === `./.github/actions/${action}`);
    expect(save).toBeGreaterThan(exportIndex);
    expect(rust[save]?.if).toBeUndefined();
    const inner = readFileSync(new URL(`../.github/actions/${action}/action.yml`, import.meta.url), "utf8");
    expect(inner).toContain("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(inner).not.toContain("ordinary-web-guests");
  }
  expect(job("ci-result").if).toBe("${{ always() }}");
  expect(named("update-status", "Report each required result on the tested commit").run).toContain("Code quality|ci-result|");
});
