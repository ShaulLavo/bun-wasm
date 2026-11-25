import { mapProgramFiles, programKind, programProfile, verifyProgramSide } from "../src/engine-kind.ts";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  GUEST_BUCKET, GUEST_CACHE_CONTROL, GUEST_ORIGIN,
  assertStandaloneArtifactModule, decodeGuest, parseGuestDescriptor, parseGuestFileDescriptor,
  readArtifactFile, readGuestArtifact, validateArtifactName, verifyGuest, writeGuestDescriptor,
} from "./guest-artifact.ts";
import type { GuestArtifact, GuestDescriptor, GuestFile, GuestFileDescriptor } from "./guest-artifact.ts";

import { acceptGuestPublication } from "./guest-acceptance.ts";
import { assertNoNameSection } from "./wasm-name-sections.ts";

const RESERVED_BUN_NAMES = new Set([
  "bun.wasm", "bun-browser.wasm", "bun-jsc.wasm", "quickjs.wasm", "jsc-engine.wasm",
  "bun-spidermonkey.wasm", "spidermonkey-engine.wasm",
]);

export type GuestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GuestPublisher {
  /** Read from authenticated storage, not a potentially cached public URL. Null means absent. */
  read(key: string): Promise<Uint8Array | null>;
  upload(artifact: GuestFile): Promise<void>;
  fetch: GuestFetch;
}

/** Verify what a browser receives, including transparent HTTP gzip decoding. */
export async function verifyPublicGuest(descriptor: GuestFileDescriptor, fetch: GuestFetch): Promise<void> {
  const origin = "https://example.com";
  const response = await fetch(descriptor.url, {
    headers: { Origin: origin },
    redirect: "error",
  });
  if (response.status !== 200) throw new Error(`Public guest returned HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/wasm") throw new Error(`Unexpected Content-Type: ${type}`);
  if (response.headers.get("content-encoding") !== "gzip") throw new Error("Public guest must have Content-Encoding: gzip");
  const cache = response.headers.get("cache-control") ?? "";
  const directives = cache.toLowerCase().split(",").map(value => value.trim());
  if (!["public", "max-age=31536000", "immutable", "no-transform"].every(value => directives.includes(value))
    || directives.some(value => ["private", "no-store", "no-cache"].includes(value))) {
    throw new Error(`Unexpected Cache-Control: ${cache}`);
  }
  if (response.headers.get("access-control-allow-origin") !== "*") throw new Error("Public guest must allow CORS GET from *");
  verifyGuest(new Uint8Array(await response.arrayBuffer()), descriptor);
}

function snapshotFile(file: GuestFile): GuestFile {
  return { key: file.key, gzip: new Uint8Array(file.gzip), descriptor: { ...file.descriptor } };
}

async function publishFile(file: GuestFile, name: string, publisher: GuestPublisher): Promise<void> {
  verifyGuest(file.gzip, file.descriptor);
  if (file.key !== `${file.descriptor.sha256}/${name}.gz`) throw new Error("Guest key does not match its SHA-256");
  const existing = await publisher.read(file.key);
  if (existing !== null) verifyGuest(existing, file.descriptor);
  else await publisher.upload(file);
  await verifyPublicGuest(file.descriptor, publisher.fetch);
}

export async function publishArtifact(file: GuestFile, name: string, publisher: GuestPublisher): Promise<GuestFileDescriptor> {
  const validName = validateArtifactName(name);
  const snapshot = snapshotFile(file);
  const descriptor = parseGuestFileDescriptor(snapshot.descriptor);
  const expectedKey = `${descriptor.sha256}/${validName}.gz`;
  const url = new URL(descriptor.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== `/${expectedKey}`) {
    throw new Error("Artifact URL must be a plain HTTPS URL matching its SHA-256 key");
  }
  assertStandaloneArtifactModule(new WebAssembly.Module(Uint8Array.from(decodeGuest(snapshot.gzip))));
  await publishFile({ ...snapshot, descriptor }, validName, publisher);
  return descriptor;
}

export async function publishGuest(artifact: GuestArtifact, publisher: GuestPublisher): Promise<GuestDescriptor> {
  const descriptor = parseGuestDescriptor(artifact.descriptor);
  const files = mapProgramFiles(artifact.files, snapshotFile);
  if (files.kind !== descriptor.kind) throw new Error("Guest descriptor does not match program kind");
  const coreName = files.kind === "single" ? "bun.wasm" : programProfile(files.kind).core;
  const core = files.core;
  if (JSON.stringify(core.descriptor) !== JSON.stringify(descriptor.core)) throw new Error("Guest descriptor does not match core identity");
  verifyGuest(core.gzip, descriptor.core);
  if (core.key !== `${descriptor.core.sha256}/${coreName}.gz`) throw new Error("Guest key does not match its SHA-256");
  if (programKind(new WebAssembly.Module(Uint8Array.from(decodeGuest(core.gzip)))) !== files.kind) throw new Error("Guest core engine declaration mismatch");
  if (files.kind !== "single" && descriptor.kind !== "single") {
    if (JSON.stringify(files.side.descriptor) !== JSON.stringify(descriptor.side)) throw new Error("Guest descriptor does not match paired engine identity");
    verifyGuest(files.side.gzip, descriptor.side);
    verifyProgramSide(files.kind, new WebAssembly.Module(Uint8Array.from(decodeGuest(files.side.gzip))));
    await publishFile(files.side, programProfile(files.kind).side, publisher);
  }
  await publishFile(core, coreName, publisher);
  return descriptor;
}

export function createR2Publisher(options: { accountId: string; token: string; bucket: string; scratch: string; wrangler: string; signal?: AbortSignal }): GuestPublisher {
  const headers = { Authorization: `Bearer ${options.token}` };
  return {
    async read(key) {
      const path = key.split("/").map(encodeURIComponent).join("/");
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/r2/buckets/${options.bucket}/objects/${path}`, { headers, signal: options.signal });
      if (response.status === 404) { await response.arrayBuffer(); return null; }
      if (!response.ok) throw new Error(`Authenticated R2 read failed: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async upload(artifact) {
      const path = join(options.scratch, basename(artifact.key));
      await writeFile(path, artifact.gzip);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [options.wrangler, "r2", "object", "put", `${options.bucket}/${artifact.key}`,
          "--remote", "--file", path, "--content-type", "application/wasm", "--content-encoding", "gzip",
          "--cache-control", GUEST_CACHE_CONTROL], {
          cwd: options.scratch,
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: options.accountId, CLOUDFLARE_API_TOKEN: options.token, WRANGLER_SEND_METRICS: "false" },
          stdio: "inherit",
          signal: options.signal,
        });
        let failure: Error | undefined;
        child.once("error", error => { failure = error; });
        // Abort emits 'error' before the process has stopped. Wait for 'close' so callers
        // cannot remove the upload file while Wrangler still has it open.
        child.once("close", code => failure ? reject(failure)
          : code === 0 ? resolve() : reject(new Error(`Wrangler guest upload exited ${code}`)));
      });
    },
    fetch: (input, init) => globalThis.fetch(input, { ...init, signal: options.signal }),
  };
}

function resolveWrangler(): string {
  const require = createRequire(new URL("../site/package.json", import.meta.url));
  return join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
}

function validateStandaloneName(raw: string, output: string | undefined): string {
  const name = validateArtifactName(raw);
  if (RESERVED_BUN_NAMES.has(name)) {
    throw new Error(`Use the default Bun guest path without --name to publish ${name}`);
  }
  if (output) throw new Error("--output writes BUN_WASM_ASSET and cannot be used with --name");
  return name;
}

interface CliPublishContext {
  readonly inputPath: string;
  readonly origin: string;
  readonly bucket: string;
  readonly dist: string;
  readonly output: string | undefined;
  readonly standaloneName: string | undefined;
  readonly accountId: string;
  readonly token: string;
  readonly scratch: string;
  readonly signal: AbortSignal;
}

async function runCliPublish(context: CliPublishContext): Promise<void> {
  if (context.standaloneName) {
    const file = await readArtifactFile(context.inputPath, context.origin, context.standaloneName);
    assertNoNameSection(decodeGuest(file.gzip), context.standaloneName);
    const r2 = createR2Publisher({ accountId: context.accountId, token: context.token, bucket: context.bucket, scratch: context.scratch, wrangler: resolveWrangler(), signal: context.signal });
    const descriptor = await publishArtifact(file, context.standaloneName, r2);
    console.log(JSON.stringify(descriptor, null, 2));
    return;
  }
  const requested = (await readGuestArtifact(context.inputPath, context.origin)).descriptor;
  const artifact = await acceptGuestPublication(resolve(context.dist), requested, context.signal);
  // Resolve the site's lockfile-pinned Wrangler only after full acceptance.
  const r2 = createR2Publisher({ accountId: context.accountId, token: context.token, bucket: context.bucket, scratch: context.scratch, wrangler: resolveWrangler(), signal: context.signal });
  const descriptor = await publishGuest(artifact, r2);
  // Publication failures must leave the consumer's existing descriptor untouched.
  if (context.output) await writeGuestDescriptor(context.output, descriptor);
  console.log(JSON.stringify(descriptor, null, 2));
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      origin: { type: "string", default: GUEST_ORIGIN },
      bucket: { type: "string", default: GUEST_BUCKET },
      name: { type: "string" },
      output: { type: "string" },
      dist: { type: "string", default: fileURLToPath(new URL("../dist/", import.meta.url)) },
      "account-id": { type: "string", default: process.env.CLOUDFLARE_ACCOUNT_ID },
    },
  });
  if (positionals.length !== 1) throw new Error("Usage: bun scripts/publish-guest.ts <artifact.wasm[.gz]> [--name artifact.wasm] [--output descriptor.ts] [--dist full-build-directory] [--origin https://host] [--bucket bucket] [--account-id id]");
  const accountId = values["account-id"];
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID or --account-id to the target account's ID");
  if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN in the environment (never pass a token as an argument)");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket!)) throw new Error("Invalid R2 bucket name");
  const standaloneName = values.name === undefined ? undefined : validateStandaloneName(values.name, values.output);
  const scratchRoot = process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = await mkdtemp(join(scratchRoot, "bun-wasm-guest-publish-"));
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Guest publication interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runCliPublish({
      inputPath: positionals[0]!,
      origin: values.origin!,
      bucket: values.bucket!,
      dist: values.dist!,
      output: values.output,
      standaloneName,
      accountId,
      token,
      scratch,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    await rm(scratch, { recursive: true, force: true });
  }
}
