import { isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { acceptedPublicationArtifact, snapshotPublicationInputs } from "../../scripts/guest-acceptance";
import { parseGuestDescriptor } from "../../scripts/guest-artifact";

/** Use the publication gate's existing descriptor, build receipts and completed matrix report. */
export function c1InputPaths(env: NodeJS.ProcessEnv) {
  const directory = requiredPath(env, "C1_GUEST_DIRECTORY");
  const descriptor = requiredPath(env, "C1_GUEST_DESCRIPTOR");
  const report = requiredPath(env, "C1_PUBLICATION_REPORT");
  const pgModules = requiredPath(env, "C1_PG_NODE_MODULES");
  const preview1 = {
    path: requiredPath(env, "C1_PREVIEW1_FIXTURE"), sha256: env.C1_PREVIEW1_SHA256,
    bytes: Number(env.C1_PREVIEW1_BYTES), expectedStdout: env.C1_PREVIEW1_STDOUT,
    host: env.C1_PREVIEW1_HOST, port: Number(env.C1_PREVIEW1_PORT),
  };
  if (!preview1.sha256 || !/^[a-f0-9]{64}$/.test(preview1.sha256) || !Number.isSafeInteger(preview1.bytes) || preview1.bytes < 8
    || !preview1.expectedStdout || !preview1.host || !Number.isInteger(preview1.port) || preview1.port < 1 || preview1.port > 65535) {
    throw new Error("C1 requires the owner's qualified plain Preview 1 fixture identity, fd 3 outside-echo destination and expected stdout");
  }
  return { directory, descriptor, report, pgModules, preview1: {
    ...preview1, sha256: preview1.sha256, expectedStdout: preview1.expectedStdout, host: preview1.host,
  } };
}

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} requires an absolute admitted input path; no C1 guest is currently admitted`);
  return value;
}

export async function admitC1Guest(inputs: ReturnType<typeof c1InputPaths>, scratch: string) {
  const descriptor = parseGuestDescriptor(JSON.parse(await readFile(inputs.descriptor, "utf8")));
  const report: unknown = JSON.parse(await readFile(inputs.report, "utf8"));
  const snapshot = await snapshotPublicationInputs(inputs.directory, descriptor, join(scratch, "artifacts"));
  const artifact = await acceptedPublicationArtifact(snapshot, report, descriptor);
  const build = snapshot.selected.receipt.sourceManifest.build;
  if (build !== "browser" && build !== "quickjs" && build !== "jsc") throw new Error("C1 requires a selected publication-matrix Bun engine");
  const pg: unknown = JSON.parse(await readFile(join(inputs.pgModules, "pg/package.json"), "utf8"));
  if (!pg || typeof pg !== "object" || !("version" in pg) || pg.version !== "8.16.3") throw new Error("C1 requires the P1 pg 8.16.3 fixture package");
  const preview1 = await readFile(inputs.preview1.path);
  verifyOwnerPreview1(preview1, inputs.preview1);
  return { artifact, engine: build, snapshot, preview1 };
}

export function c1Ports(env: NodeJS.ProcessEnv) {
  const ports = {
    page: port(env.C1_PAGE_PORT, 43829), relay: port(env.C1_RELAY_PORT, 43830),
    webtransport: port(env.C1_WT_PORT, 4433), postgres: port(env.C1_PG_PORT, 45432),
  };
  if (new Set(Object.values(ports)).size !== 4) throw new Error("C1 listener ports must be distinct");
  return ports;
}

function port(input: string | undefined, fallback: number): number {
  const value = input === undefined ? fallback : Number(input);
  if (!Number.isInteger(value) || value < 1025 || value > 65535) throw new Error("C1 requires unprivileged exact localhost ports");
  return value;
}

/** Registered before setup; each owner registers its close before it starts listening. */
export class C1Cleanup {
  private readonly closers: Array<() => void | Promise<void>> = [];
  private closing: Promise<void> | undefined;
  add(close: () => void | Promise<void>): void { this.closers.push(close); }
  close(): Promise<void> { return this.closing ??= this.drain(); }
  private async drain(): Promise<void> {
    const failures: unknown[] = [];
    for (const close of this.closers.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "C1 cleanup failed");
  }
}

export function verifyOwnerPreview1(bytes: Uint8Array, expected: { readonly sha256: string; readonly bytes: number }): void {
  if (bytes.byteLength !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error("C1 owner Preview 1 fixture bytes differ from the qualified identity");
}

export async function c1SetupReady(ready: Promise<unknown>, signal: AbortSignal): Promise<void> {
  const cancelled = Promise.withResolvers<never>();
  const stop = () => cancelled.reject(new Error("C1 setup cancelled"));
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try { await Promise.race([ready, cancelled.promise]); }
  finally { signal.removeEventListener("abort", stop); }
}
