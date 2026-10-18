import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeGuest, prepareGuest, verifyGuest, type GuestArtifact, type GuestDescriptor } from "./guest-artifact.ts";

const artifacts = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"] as const;
const browsers = ["chromium", "firefox", "webkit"] as const;
interface ArtifactReceipt { name: string; sha256: string; bytes: number }
export interface PublicationSnapshot {
  directory: string;
  artifacts: readonly ArtifactReceipt[];
  selected: ArtifactReceipt;
}

/** Missing siblings are a hard failure for publication, never a skipped gate. */
export async function verifyPublicationInputs(dist: string, descriptor: GuestDescriptor): Promise<void> {
  const missing: string[] = [];
  for (const name of artifacts) {
    const path = join(dist, name);
    const metadata = await stat(path).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!metadata?.isFile() || metadata.size === 0) missing.push(path);
  }
  if (missing.length) throw new Error(`Guest publication requires the full interruption matrix; missing: ${missing.join(", ")}`);
  for (const name of artifacts) {
    const candidate = describeGuest(await readFile(join(dist, name)));
    if (candidate.sha256 === descriptor.sha256 && candidate.bytes === descriptor.bytes) return;
  }
  throw new Error("Guest publication integrity mismatch: upload is not one of the tested matrix artifacts");
}

/** The caller owns directory cleanup. Copy into new inodes, never links to a live build. */
export async function snapshotPublicationInputs(dist: string, descriptor: GuestDescriptor, directory: string): Promise<PublicationSnapshot> {
  await verifyPublicationInputs(dist, descriptor);
  await mkdir(directory, { mode: 0o700 });
  const receipts: ArtifactReceipt[] = [];
  for (const name of artifacts) {
    const bytes = await readFile(join(dist, name));
    const candidate = describeGuest(bytes);
    await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o400 });
    receipts.push({ name, sha256: candidate.sha256, bytes: candidate.bytes });
  }
  const selected = receipts.find(candidate => candidate.sha256 === descriptor.sha256 && candidate.bytes === descriptor.bytes);
  if (!selected) throw new Error("Guest publication integrity mismatch: build changed before snapshot");
  await chmod(directory, 0o500);
  return { directory, artifacts: receipts, selected };
}

/** Evidence comes from the exact ArrayBuffers each browser hashed and compiled. */
export function verifyPublicationReport(snapshot: PublicationSnapshot, report: unknown): void {
  const output = report as { ok?: boolean; cleanup?: { safe?: boolean }; unsafeCleanup?: unknown; reports?: {
    browser: string; ok: boolean; artifacts: ArtifactReceipt[];
  }[] };
  assert.equal(output?.ok, true, "publication browser matrix passed");
  assert.equal(output.cleanup?.safe, true, "publication runner cleanup passed");
  assert.ok(!output.unsafeCleanup, "publication has no unsafe cleanup");
  assert.ok(Array.isArray(output.reports), "publication includes browser receipts");
  assert.deepEqual(output.reports.map(browser => browser.browser).sort(), Array.from(browsers).sort(), "all publication browsers supplied receipts");
  for (const browser of output.reports) {
    assert.equal(browser.ok, true, `${browser.browser} acceptance passed`);
    assert.equal(browser.artifacts.length, snapshot.artifacts.length, `${browser.browser} artifact receipt count`);
    assert.equal(new Set(browser.artifacts.map(artifact => artifact.name)).size, snapshot.artifacts.length, "distinct artifact receipts");
    for (const expected of snapshot.artifacts) {
      const loaded = browser.artifacts.find(artifact => artifact.name === expected.name);
      assert.equal(loaded?.sha256, expected.sha256, `${browser.browser} loaded SHA-256 for ${expected.name}`);
      assert.equal(loaded?.bytes, expected.bytes, `${browser.browser} loaded byte count for ${expected.name}`);
    }
  }
}

async function runAcceptance(snapshot: PublicationSnapshot, output: string, signal: AbortSignal): Promise<void> {
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(web, "tests/browser-engine-interruption.ts")].concat(browsers), {
      cwd: web,
      env: { ...process.env, BUN_WASM_INTERRUPTION_DIST: snapshot.directory, ENGINE_INTERRUPTION_OUTPUT: output },
      stdio: "inherit",
    });
    // The runner owns browser/profile/listener teardown. Signal it normally and
    // await close before publication can remove its private artifact snapshot.
    const abort = () => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let failure: Error | undefined;
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(`Guest publication interruption gate failed (${code})`));
      resolve();
    });
  });
}

/** Upload data is read only from the tested snapshot, never from the live dist. */
export async function acceptedPublicationArtifact(snapshot: PublicationSnapshot, report: unknown, descriptor: GuestDescriptor): Promise<GuestArtifact> {
  verifyPublicationReport(snapshot, report);
  const bytes = await readFile(join(snapshot.directory, snapshot.selected.name));
  verifyGuest(bytes, descriptor);
  return prepareGuest(bytes, new URL(descriptor.url).origin);
}

export async function acceptGuestPublication(dist: string, descriptor: GuestDescriptor, signal: AbortSignal): Promise<GuestArtifact> {
  signal.throwIfAborted();
  const scratchRoot = process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-publication-"));
  const directory = join(scratch, "artifacts"), output = join(scratch, "acceptance.json");
  try {
    const snapshot = await snapshotPublicationInputs(dist, descriptor, directory);
    signal.throwIfAborted();
    await runAcceptance(snapshot, output, signal);
    signal.throwIfAborted();
    const artifact = await acceptedPublicationArtifact(snapshot, JSON.parse(await readFile(output, "utf8")), descriptor);
    console.log(JSON.stringify({ publicationAcceptance: { artifacts: snapshot.artifacts, upload: artifact.descriptor } }));
    return artifact;
  } finally {
    // Restore only our directory's delete permission after its consumers close.
    await chmod(directory, 0o700).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rm(scratch, { recursive: true, force: true });
  }
}
