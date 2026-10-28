import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { guestProvenance } from "../../scripts/app-matrix/product-provenance";
import { registry } from "../../scripts/app-matrix/registry.mjs";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt";
import { bounded, createProductCleanup, exitAfterDeadline } from "../shell-product/lifecycle";

type RunMode = "acceptance" | "prepare-registry";
export function runMode(args: readonly string[]): RunMode {
  if (args.length === 0) return "acceptance";
  assert(args.length === 1 && args[0] === "--prepare-registry", "Usage: ten-app-finishline.ts APP [--prepare-registry]");
  return "prepare-registry";
}
export async function acceptedGuest(environment: NodeJS.ProcessEnv) {
  const artifact = environment.SHELL_PRODUCT_GUEST;
  const accepted = environment.SHELL_PRODUCT_RECEIPT;
  assert(artifact && accepted && isAbsolute(artifact) && isAbsolute(accepted), "Set absolute SHELL_PRODUCT_GUEST and SHELL_PRODUCT_RECEIPT");
  const bytes = await Bun.file(artifact).bytes();
  const sidecar: unknown = await Bun.file(`${artifact}.build.json`).json();
  verifyGuestBuildReceipt(bytes, sidecar);
  const provenance = guestProvenance(await readFile(accepted, "utf8"), { sha256: sidecar.program.core.artifactSha256, bytes: sidecar.program.core.artifactBytes });
  assert.deepEqual(sidecar.sourceManifest.source, { head: provenance.source_commit, tree: provenance.source_tree }, "Accepted guest source differs from build receipt");
  return { bytes, artifact, accepted, source: provenance.source_commit, provenance };
}
export async function openRegistry(directory: string, mode: RunMode) {
  assert(isAbsolute(directory), "SHELL_PRODUCT_REGISTRY must be absolute");
  if (mode === "acceptance") {
    assert((await stat(join(directory, "index.json"))).isFile(), "Existing replay index required");
    assert((await stat(join(directory, "objects"))).isDirectory(), "Existing replay objects required");
  }
  return registry({ directory, record: mode === "prepare-registry" });
}
export function networkSnapshot(mirror: Awaited<ReturnType<typeof openRegistry>> | undefined, external: readonly string[], save: (name: string, value: unknown) => void) {
  save("registry.json", mirror?.snapshot() ?? null);
  save("external.json", external);
  assert.deepEqual(external.concat(mirror?.misses ?? [], mirror?.errors ?? []), [], "External requests or registry replay misses/errors");
}
function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return [error.stack ?? error.message].concat(Array.from(error.errors, errorMessage)).join("\n");
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
type FailureReport = { primary: string | null; secondary: string[]; unverified: string[] };
type SignalSource = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
};
type Cleanup = Parameters<typeof createProductCleanup>[0];
export function createFinishlineRun(options: {
  cleanup: Cleanup;
  snapshot: () => void;
  report: (failure: FailureReport) => void;
  timeout?: number;
  cleanupTimeout?: number;
  signals?: SignalSource;
  exit?: () => void;
}) {
  const resources = createProductCleanup(options.cleanup);
  const signals = options.signals ?? process;
  const grace = options.cleanupTimeout ?? 3000;
  let primary: Error | undefined;
  const secondary: string[] = [];
  let stopped = false;
  let finishing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  function report() {
    try { options.report({ primary: primary ? errorMessage(primary) : null, secondary, unverified: resources.unverified() }); }
    catch (error) { secondary.push(errorMessage(error)); console.error(error); }
  }
  function fail(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!primary) { primary = failure; console.error(failure); }
    else if (errorMessage(primary) !== errorMessage(failure) && !secondary.includes(errorMessage(failure))) { secondary.push(errorMessage(failure)); console.error(failure); }
    report();
  }
  function check() { if (stopped) throw primary ?? new Error("Finish-line run stopped"); }
  async function finalize() {
    try { options.snapshot(); } catch (error) { fail(error); }
    try { await resources.cleanup(); } catch (error) { fail(error); }
    try { options.snapshot(); } catch (error) { fail(error); }
    report();
  }
  function finish() { return finishing ??= finalize(); }
  function stop(reason: Error) {
    if (stopping) return stopping;
    stopped = true;
    fail(reason);
    return stopping = exitAfterDeadline({ primary: primary ?? reason, cleanup: finish, timeout: grace, report: fail, unverified: resources.unverified, exit: options.exit ?? (() => process.exit(1)) });
  }
  async function complete() {
    try { await bounded(finish(), grace, "finish-line cleanup"); }
    catch (error) { await stop(error instanceof Error ? error : new Error(String(error))); }
    if (resources.unverified().length) await stop(new Error("Finish-line cleanup left unverified resources"));
  }
  async function run(execute: () => Promise<void>) {
    const onSignal = () => { void stop(new Error("Finish-line run interrupted")); };
    const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const name of names) signals.on(name, onSignal);
    const deadline = setTimeout(() => void stop(new Error("Finish-line overall deadline")), options.timeout ?? 600000);
    try { await execute(); check(); } catch (error) { fail(error); }
    finally {
      stopped = true;
      await complete();
      clearTimeout(deadline);
      for (const name of names) signals.off(name, onSignal);
    }
    return primary || secondary.length ? 1 : 0;
  }
  return { check, fail, run };
}
