import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { TLS_STAGE, digest, preflightTls, recheckDependencies, MissingTlsInput, type TlsEvidence } from "./tls-qualification-inputs.ts";
import { qualifiedRun } from "./tls-qualification-lifecycle.ts";
import { isEngine } from "./tls-qualification-context.ts";
import { startTlsServices } from "../web/tests/tls-relay-services.ts";
import { runTlsBrowser } from "../web/tests/tls-relay-browser.ts";

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
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("TLS qualification interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  const timer = setTimeout(stop, 10 * 60_000);
  try {
    let serviceObservation: (() => unknown) | undefined;
    let output: string | undefined;
    const result = await qualifiedRun(() => preflightTls(options.evidence), async (intake, owner) => {
      abort.signal.throwIfAborted();
      await recheckDependencies(intake);
      abort.signal.throwIfAborted();
      const mount = execFileSync("findmnt", ["-T", "/work/tmp", "-n", "-o", "TARGET"], { encoding: "utf8", timeout: 5000 }).trim();
      if (!mount.startsWith("/work")) throw new Error("TLS qualification requires the mounted data drive");
      abort.signal.throwIfAborted();
      // A fresh stage directory inside the controller's own TLS output; a leftover result refuses.
      const owned = intake.output;
      await mkdir(owned);
      output = owned;
      abort.signal.throwIfAborted();
      const machine = intake.fixtures.databaseMachine;
      const remoteBefore = execFileSync("mesh", ["ssh", machine, "--", "sh", "-c", "ps -eo pid,comm; command -v bun; command -v initdb; command -v postgres; command -v pg_isready; command -v openssl; df -Pk /work/tmp"], { encoding: "utf8", timeout: 15_000 });
      abort.signal.throwIfAborted();
      await writeFile(join(owned, "resources.before.json"), JSON.stringify({ host: hostname(), localBefore: execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf8" }), remoteHost: machine, remoteBefore, creates: ["private remote PostgreSQL scratch and processes", "run-generated CA and password", "raw TCP audit proxy", "loopback authenticated relay and page", "Chromium context"], frozenDelivery: intake.handoff.delivery.root }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const created: object[] = [];
      const record = async (resource: object) => { created.push(resource); await writeFile(join(owned, "resources.created.json"), JSON.stringify(created, null, 2) + "\n", { mode: 0o600 }); };
      const services = await startTlsServices(intake, owner, intake.fixtures, abort.signal, record);
      serviceObservation = services.lifecycle;
      await record(services.resources);
      return { intake, services, owner };
    }, async ({ intake, services, owner }) => runTlsBrowser(intake, services, owner, options.engine, abort.signal), abort.signal);
    abort.signal.throwIfAborted();
    if (!output) throw new Error("TLS output was never claimed");
    await writeFile(join(output, "cleanup.json"), JSON.stringify({ services: serviceObservation?.() }) + "\n");
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("TLS result exceeds the bounded evidence size; no result may be truncated");
    await writeFile(join(output, "result.json"), serialized, { mode: 0o600 });
  } finally {
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}
if (import.meta.main) {
  try { await tlsQualification(process.argv.slice(2)); }
  catch (error) { if (error instanceof MissingTlsInput) process.stderr.write(`${error.code}: ${error.message}\n`); process.stderr.write("TLS qualification failed. No application TLS acceptance is claimed.\n"); process.exitCode = 1; }
}
