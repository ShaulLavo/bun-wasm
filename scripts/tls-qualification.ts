import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { digest, preflightTls, type TlsEvidence } from "./tls-qualification-inputs.ts";
import { qualifiedRun } from "./tls-qualification-lifecycle.ts";
import { isEngine } from "./tls-qualification-context.ts";
import { startTlsServices, type ServiceOptions } from "../web/tests/tls-relay-services.ts";
import { removeTlsScratch, runTlsBrowser } from "../web/tests/tls-relay-browser.ts";

export function parseTlsArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  const allowed = ["stage", "delivery", "admission", "admission-sha256", "delivery-sha256", "source-release-sha256", "reviewed-head", "reviewed-tree", "host-source", "pg-node-modules", "pg-tarball", "pg-tarball-sha256", "browser", "engine", "output", "database-machine", "database-address", "relay-address", "page-port", "relay-port"];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith("--") || !value || !allowed.includes(flag.slice(2)) || values.has(flag.slice(2))) throw new Error("Unknown, repeated or incomplete TLS qualification option");
    values.set(flag.slice(2), value);
  }
  const required = (name: string): string => { const value = values.get(name); if (!value) throw new Error(`--${name} is required; no TLS application tuple is admitted by default`); return value; };
  if (required("stage") !== "pg-early" || required("browser") !== "chromium") throw new Error("This source unit supports only pg-early on Chromium with forced WebSocket");
  const engine = values.get("engine") ?? "browser";
  if (!isEngine(engine)) throw new Error("Select an exact supported engine");
  const evidence: TlsEvidence = {
    delivery: required("delivery"), admission: required("admission"), hostSource: required("host-source"), pgModules: required("pg-node-modules"), pgArchive: required("pg-tarball"), pgArchiveSha256: digest(required("pg-tarball-sha256"), "pg tarball SHA-256"),
    admissionSha256: digest(required("admission-sha256"), "admission SHA-256"), deliverySha256: digest(required("delivery-sha256"), "delivery SHA-256"),
    sourceReleaseSha256: digest(required("source-release-sha256"), "source release SHA-256"),
    reviewedSource: { head: digest(required("reviewed-head"), "reviewed TLS head", 40), tree: digest(required("reviewed-tree"), "reviewed TLS tree", 40) },
  };
  const output = required("output");
  if (!isAbsolute(output)) throw new Error("TLS output must be absolute");
  const databaseMachine = required("database-machine");
  const ipv4 = (value: string): string => { if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.split(".").some(part => Number(part) > 255)) throw new Error("Exact private IPv4 required"); return value; };
  const databaseAddress = ipv4(required("database-address"));
  const relayAddress = ipv4(required("relay-address"));
  const privateAddress = (address: string) => address.startsWith("10.") || address.startsWith("192.168.") || address.startsWith("172.") && Number(address.split(".")[1]) >= 16 && Number(address.split(".")[1]) <= 31 || address.startsWith("100.") && Number(address.split(".")[1]) >= 64 && Number(address.split(".")[1]) <= 127;
  if (!privateAddress(databaseAddress) || !privateAddress(relayAddress) || databaseAddress === relayAddress) throw new Error("TLS requires distinct approved private database and relay addresses");
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseMachine) || ["pc", "localhost"].includes(databaseMachine) || databaseAddress.startsWith("127.")) throw new Error("PostgreSQL must use a separately approved fleet host, not the page host");
  const port = (name: string, fallback: number) => { const value = Number(values.get(name) ?? fallback); if (!Number.isInteger(value) || value < 1025 || value > 65535) throw new Error("Unprivileged exact TLS ports required"); return value; };
  const services: ServiceOptions = { databaseMachine, databaseAddress, relayAddress, pagePort: port("page-port", 43839), relayPort: port("relay-port", 43840) };
  if (services.pagePort === services.relayPort) throw new Error("TLS page and relay ports must differ");
  return { evidence, output: resolve(output), services, engine };
}
export async function tlsQualification(args: readonly string[]): Promise<void> {
  const options = parseTlsArguments(args);
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("TLS qualification interrupted"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);
  const timer = setTimeout(stop, 10 * 60_000);
  try {
    const result = await qualifiedRun(() => preflightTls(options.evidence), async (intake, owner) => {
      // Evidence has been checked before any directory, page, service or remote setup.
      const mount = execFileSync("findmnt", ["-T", "/work/tmp", "-n", "-o", "TARGET"], { encoding: "utf8", timeout: 5000 }).trim();
      if (!mount.startsWith("/work")) throw new Error("TLS qualification requires the mounted data drive");
      await mkdir(options.output, { recursive: true });
      const remoteBefore = execFileSync("mesh", ["ssh", options.services.databaseMachine, "--", "sh", "-c", "ps -eo pid,comm; command -v bun; command -v initdb; command -v postgres; command -v pg_isready; command -v openssl; df -Pk /work/tmp"], { encoding: "utf8", timeout: 15_000 });
      await writeFile(join(options.output, "resources.before.json"), JSON.stringify({ host: hostname(), localBefore: execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf8" }), remoteHost: options.services.databaseMachine, remoteBefore, creates: ["private remote PostgreSQL scratch and processes", "run-generated CA and password", "raw TCP audit proxy", "loopback authenticated relay and page", "Chromium context", "private local build scratch"], frozenDelivery: intake.inputs.delivery }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const scratch = await mkdtemp("/work/tmp/bun-wasm-tls-browser-");
      owner.add(async () => { await removeTlsScratch(scratch); });
      const created: object[] = [];
      const record = async (resource: object) => { created.push(resource); await writeFile(join(options.output, "resources.created.json"), JSON.stringify(created, null, 2) + "\n", { mode: 0o600 }); };
      const services = await startTlsServices(intake, owner, options.services, abort.signal, record);
      await record(services.resources);
      return { intake, services, owner, scratch };
    }, async ({ intake, services, owner, scratch }) => runTlsBrowser(intake, services, owner, options.services, options.engine, scratch, abort.signal));
    await writeFile(join(options.output, "cleanup.json"), JSON.stringify({ scratchAbsent: true, ownedClosersCompleted: true, retained: [] }) + "\n");
    await writeFile(join(options.output, "result.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  } finally {
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}
if (import.meta.main) {
  try { await tlsQualification(process.argv.slice(2)); }
  catch { process.stderr.write("TLS qualification failed. No application TLS acceptance is claimed.\n"); process.exitCode = 1; }
}
