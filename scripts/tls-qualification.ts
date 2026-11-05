import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { TLS_STAGE, digest, preflightTls, recheckDependencies, type TlsEvidence } from "./tls-qualification-inputs.ts";
import { qualifiedRun } from "./tls-qualification-lifecycle.ts";
import { isEngine } from "./tls-qualification-context.ts";
import { startTlsServices } from "../web/tests/tls-relay-services.ts";
import { runTlsBrowser } from "../web/tests/tls-relay-browser.ts";

type TlsPhase = "arguments" | "preflight" | "dependencies" | "mount" | "output-directory"
  | "pre-ledger-remote-inventory" | "pre-ledger-local-inventory" | "resource-ledger" | "services" | "browser" | "cleanup-receipt" | "result";
export class TlsQualificationFailure extends Error {
  constructor(readonly phase: TlsPhase, cause: unknown) { super(`TLS qualification failed during ${phase}`, { cause }); }
}
function errorDetails(error: unknown, includeMessage: boolean) {
  const details: Record<string, string | number | null> = { name: error instanceof Error ? error.name : "NonErrorThrow" };
  if (!(error instanceof Error)) return details;
  if (includeMessage) details.message = error.message;
  for (const key of ["code", "errno", "syscall", "path", "status", "signal"]) {
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number" || value === null) details[key] = value;
  }
  return details;
}
export function formatTlsFailure(error: unknown): string {
  const phase = error instanceof TlsQualificationFailure ? error.phase : "arguments";
  const failure = error instanceof TlsQualificationFailure ? error.cause : error;
  const primary = failure instanceof AggregateError && "cause" in failure ? failure.cause : failure;
  const related: unknown[] = failure instanceof AggregateError ? failure.errors : [];
  // Only credential-free admission/inventory phases may retain the original message.
  // Captured stdout/stderr, argv, environment, stacks and post-setup messages never leave this boundary.
  const includeMessage = ["arguments", "preflight", "dependencies", "mount", "output-directory", "pre-ledger-remote-inventory", "pre-ledger-local-inventory", "resource-ledger"].includes(phase);
  return JSON.stringify({ kind: "tls-qualification-failure", phase, primary: errorDetails(primary, includeMessage), relatedErrors: related.map(error => errorDetails(error, false)), qualification: false });
}
/**
 * The first setup or exercise error, recorded before the lifecycle's cleanup
 * runs. tls-qualification-lifecycle.ts is a bundled input of the sealed TLS
 * page, so it stays unchanged; a later cleanup error is attached here instead
 * of replacing the primary cause.
 */
export class FirstFailure {
  private first: { readonly error: unknown } | null = null;
  guard<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      try { return await operation(...args); }
      catch (error) { this.first ??= { error }; throw error; }
    };
  }
  resolve(caught: unknown): unknown {
    if (!this.first || this.first.error === caught) return caught;
    return new AggregateError([this.first.error, caught], "TLS operation and cleanup failed", { cause: this.first.error });
  }
}
export async function runTlsCli(run: () => Promise<void>, write: (message: string) => void): Promise<0 | 1> {
  try { await run(); return 0; } catch (error) {
    write(formatTlsFailure(error) + "\n");
    write("TLS qualification failed. No application TLS acceptance is claimed.\n");
    return 1;
  }
}

function canonicalAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a canonical absolute path`);
  return value;
}
/**
 * The controller's invocation: the pinned handoff carries every other input
 * (intake, source, dependencies, fixture options, sealed page), and the
 * output is that handoff's stage directory beneath its TLS output.
 */
export function parseTlsArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  const allowed = ["stage", "browser", "engine", "handoff", "handoff-sha256", "output"];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith("--") || !value || !allowed.includes(flag.slice(2)) || values.has(flag.slice(2))) throw new Error("Unknown, repeated or incomplete TLS qualification option");
    values.set(flag.slice(2), value);
  }
  const required = (name: string): string => { const value = values.get(name); if (!value) throw new Error(`--${name} is required; no TLS application tuple is admitted by default`); return value; };
  if (required("stage") !== TLS_STAGE || required("browser") !== "chromium") throw new Error("This source unit supports only pg-early on Chromium with forced WebSocket");
  const engine = values.get("engine") ?? "browser";
  if (!isEngine(engine)) throw new Error("Select an exact supported engine");
  const evidence: TlsEvidence = { handoff: canonicalAbsolute(required("handoff"), "TLS handoff"), handoffSha256: digest(required("handoff-sha256"), "handoff SHA-256"),
    output: canonicalAbsolute(required("output"), "TLS output") };
  return { evidence, engine };
}
export async function tlsQualification(args: readonly string[]): Promise<void> {
  const options = parseTlsArguments(args);
  let phase: TlsPhase = "preflight";
  const first = new FirstFailure();
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("TLS qualification interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  const timer = setTimeout(stop, 10 * 60_000);
  try {
    let serviceObservation: (() => unknown) | undefined;
    let output: string | undefined;
    const result = await qualifiedRun(() => preflightTls(options.evidence), first.guard(async (intake, owner) => {
      abort.signal.throwIfAborted();
      phase = "dependencies";
      await recheckDependencies(intake);
      abort.signal.throwIfAborted();
      phase = "mount";
      const mount = execFileSync("findmnt", ["-T", "/work/tmp", "-n", "-o", "TARGET"], { encoding: "utf8", timeout: 5000 }).trim();
      if (!mount.startsWith("/work")) throw new Error("TLS qualification requires the mounted data drive");
      abort.signal.throwIfAborted();
      // A fresh stage directory inside the controller's own TLS output; a leftover result refuses.
      phase = "output-directory";
      const owned = intake.output;
      await mkdir(owned);
      output = owned;
      abort.signal.throwIfAborted();
      const machine = intake.fixtures.databaseMachine;
      phase = "pre-ledger-remote-inventory";
      const remoteBefore = execFileSync("mesh", ["ssh", machine, "--", "sh", "-c", 'set -eu; test ! -e "$HOME/.local/state/machine-fleet/owner-busy"; ps -eo pid,comm; command -v bun; command -v podman; command -v openssl; test -d "$HOME/tmp"; df -Pk "$HOME/tmp"; tailscale ip -4; podman info --format "{{.Host.Security.Rootless}}"; podman ps -a --format json; podman volume ls --format json; podman images --format json; ss -lnt'], { encoding: "utf8", timeout: 15_000 });
      abort.signal.throwIfAborted();
      phase = "pre-ledger-local-inventory";
      const localBefore = execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf8" });
      phase = "resource-ledger";
      await writeFile(join(owned, "resources.before.json"), JSON.stringify({ host: hostname(), localBefore, remoteHost: machine, remoteBefore, creates: ["PC Pi lane flock lease process", "private Pi home/tmp scratch, uniquely named rootless Podman container and volume using the parent-held digest image", "run-generated CA and password", "raw TCP audit proxy", "loopback authenticated relay and page", "Chromium context"], frozenDelivery: intake.handoff.delivery.root }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const created: object[] = [];
      const record = async (resource: object) => { created.push(resource); await writeFile(join(owned, "resources.created.json"), JSON.stringify(created, null, 2) + "\n", { mode: 0o600 }); };
      phase = "services";
      const services = await startTlsServices(intake, owner, intake.fixtures, abort.signal, record);
      serviceObservation = services.lifecycle;
      await record(services.resources);
      return { intake, services, owner };
    }), first.guard(async ({ intake, services, owner }) => { phase = "browser"; return runTlsBrowser(intake, services, owner, options.engine, abort.signal); }), abort.signal);
    abort.signal.throwIfAborted();
    if (!output) throw new Error("TLS output was never claimed");
    phase = "cleanup-receipt";
    await writeFile(join(output, "cleanup.json"), JSON.stringify({ services: serviceObservation?.() }) + "\n");
    phase = "result";
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("TLS result exceeds the bounded evidence size; no result may be truncated");
    await writeFile(join(output, "result.json"), serialized, { mode: 0o600 });
  } catch (error) { throw new TlsQualificationFailure(phase, first.resolve(error)); } finally {
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}
if (import.meta.main) process.exitCode = await runTlsCli(() => tlsQualification(process.argv.slice(2)), message => { process.stderr.write(message); });
