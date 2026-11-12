import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tlsPagePaths } from "../producer-closure.ts";
import { sameSource, type SourceIdentity } from "./contract.ts";
import { fileIdentity, inside, sameBytes } from "./identity.ts";
import { cleanSource } from "./inputs.ts";

/**
 * The TLS consumer's page is producer work: built once from the selected
 * source before sealing, never by the consumer. The entry and the maintained
 * worker realms are bundled by the maintained browser builder, exactly as the
 * TLS helper bundles them, and every bundled input and output is bound here.
 */
export const TLS_PAGE_ENTRY = "web/tests/tls-relay-page.ts";
export const TLS_PAGE_WORKERS = ["web/src/worker.ts", "web/src/fs-worker.ts", "web/src/notification-worker.ts"];
export const TLS_PG_CLIENT = "web/tests/fixtures/tls/pg-client.ts";
export const TLS_PAGE_INDEX = '<!doctype html><title>Guest PostgreSQL TLS qualification</title><script type="module" src="/tls-relay-page.js"></script>';
/** A bundle that still names this specifier would resolve its relay at run time, outside the sealed bytes. */
export const UNRESOLVED_RELAY = "tls-reviewed-relay";

class TlsPageError extends Error {}
function fail(message: string): never { throw new TlsPageError(message); }

export type PageBuilder = (entries: string[], outdir: string, options: { runtimeWorker: boolean }) => Promise<{ metafile?: { inputs: Record<string, unknown> } }>;
interface Identity { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface TlsPageReceipt {
  readonly schema: "bun-wasm.c1-tls-page/1";
  readonly source: SourceIdentity;
  readonly entry: string;
  readonly workers: readonly string[];
  /** Every bundled input, relative to the source root (sources and staged dependencies). */
  readonly inputs: readonly Identity[];
  /** Every file under `tls/` except this receipt, relative to `tls/`. */
  readonly outputs: readonly Identity[];
}

function files(root: string, path = ""): string[] {
  return readdirSync(join(root, path)).sort().flatMap(name => {
    const member = path ? `${path}/${name}` : name;
    const stat = lstatSync(join(root, member));
    if (stat.isDirectory()) return files(root, member);
    if (!stat.isFile()) fail(`TLS page output is not a regular file: ${member}`);
    return [member];
  });
}
function identity(root: string, path: string): Identity {
  const file = fileIdentity(join(root, path));
  return { path, bytes: file.bytes, sha256: file.sha256 };
}
const receiptName = relative("tls", tlsPagePaths.receipt);
function outputs(tls: string): Identity[] {
  return files(tls).filter(path => path !== receiptName).map(path => identity(tls, path));
}
function requireResolvedRelay(tls: string, rows: readonly Identity[]): void {
  const unresolved = rows.filter(row => row.path.endsWith(".js") && readFileSync(join(tls, row.path), "utf8").includes(UNRESOLVED_RELAY));
  if (unresolved.length) fail(`TLS page still imports "${UNRESOLVED_RELAY}" at run time (${unresolved.map(row => row.path).join(", ")}); its relay import must be static so the sealed page carries it`);
}
function inputIdentities(sourceRoot: string, inputs: Record<string, unknown>): Identity[] {
  return Object.keys(inputs).sort().map(input => {
    const path = resolve(sourceRoot, input);
    if (!inside(sourceRoot, path) || !inside(realpathSync(sourceRoot), realpathSync(path))) fail(`TLS page bundled an input outside the selected source: ${input}`);
    return identity(sourceRoot, relative(sourceRoot, path));
  });
}

/** Build the page into `tls` (which must not exist) and write its receipt. */
export async function prepareTlsPage(sourceRoot: string, source: SourceIdentity, tls: string, build: PageBuilder): Promise<TlsPageReceipt> {
  if (existsSync(tls)) fail(`TLS page output already exists: ${tls}`);
  const page = join(tls, relative("tls", tlsPagePaths.root));
  mkdirSync(page, { recursive: true });
  const result = await build([TLS_PAGE_ENTRY].concat(TLS_PAGE_WORKERS).map(path => join(sourceRoot, path)), page, { runtimeWorker: true });
  if (!result.metafile) fail("TLS page build returned no input record");
  writeFileSync(join(tls, relative("tls", tlsPagePaths.index)), TLS_PAGE_INDEX, { flag: "wx" });
  const client = join(tls, relative("tls", tlsPagePaths.pgClient));
  mkdirSync(dirname(client), { recursive: true });
  copyFileSync(join(sourceRoot, TLS_PG_CLIENT), client);
  const rows = outputs(tls);
  requireResolvedRelay(tls, rows);
  const receipt: TlsPageReceipt = { schema: "bun-wasm.c1-tls-page/1", source, entry: TLS_PAGE_ENTRY, workers: TLS_PAGE_WORKERS, inputs: inputIdentities(sourceRoot, result.metafile.inputs), outputs: rows };
  writeFileSync(join(tls, receiptName), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  // The written receipt must itself be complete: entry and every maintained worker among its inputs.
  return parseReceipt(join(tls, receiptName));
}

function identityRows(value: unknown, label: string): Identity[] {
  if (!Array.isArray(value) || value.length === 0) fail(`TLS page receipt ${label} must be a non-empty list`);
  const rows = value.map((row: unknown) => {
    const fields = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : fail(`TLS page receipt ${label} row is not an object`);
    const { path, bytes, sha256: digest } = fields;
    if (Object.keys(fields).sort().join(",") !== "bytes,path,sha256" || typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\")
      || path.split("/").some(part => part === "" || part === "." || part === "..") || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0
      || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail(`TLS page receipt ${label} row is malformed`);
    return { path, bytes, sha256: digest };
  });
  if (new Set(rows.map(row => row.path)).size !== rows.length) fail(`TLS page receipt ${label} repeats a path`);
  return rows;
}
function parseReceipt(path: string): TlsPageReceipt {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("TLS page receipt is not an object");
  if (Object.keys(fields).sort().join(",") !== "entry,inputs,outputs,schema,source,workers" || fields.schema !== "bun-wasm.c1-tls-page/1"
    || fields.entry !== TLS_PAGE_ENTRY || JSON.stringify(fields.workers) !== JSON.stringify(TLS_PAGE_WORKERS)) fail("invalid TLS page receipt");
  const source = fields.source as SourceIdentity;
  if (!source || typeof source.head !== "string" || typeof source.tree !== "string") fail("TLS page receipt has no source");
  const inputs = identityRows(fields.inputs, "inputs");
  const listed = new Set(inputs.map(input => input.path));
  for (const required of [TLS_PAGE_ENTRY].concat(TLS_PAGE_WORKERS)) if (!listed.has(required)) fail(`TLS page receipt inputs omit ${required}`);
  return { schema: "bun-wasm.c1-tls-page/1", source: { head: source.head, tree: source.tree }, entry: TLS_PAGE_ENTRY, workers: TLS_PAGE_WORKERS, inputs, outputs: identityRows(fields.outputs, "outputs") };
}
/** A bundled input read back through no link outside the selected source checkout. */
function requireInput(sourceRoot: string, input: Identity): void {
  const path = join(sourceRoot, input.path);
  if (!inside(realpathSync(sourceRoot), realpathSync(path))) fail(`TLS page input resolves outside the selected source: ${input.path}`);
  if (!sameBytes(fileIdentity(path), input)) fail(`TLS page input changed: ${input.path}`);
}
/**
 * The delivered page is exactly what its receipt lists, built from this
 * source, with its bundled inputs unchanged and its relay import resolved.
 */
export function verifyTlsPage(delivery: string, sourceRoot: string, source: SourceIdentity): TlsPageReceipt {
  const tls = join(delivery, "tls");
  const receipt = parseReceipt(join(tls, receiptName));
  if (!sameSource(receipt.source, source)) fail("TLS page was built from another source");
  const actual = outputs(tls);
  if (JSON.stringify(actual) !== JSON.stringify(receipt.outputs)) fail("TLS page files differ from its receipt");
  const listed = new Set(actual.map(row => `tls/${row.path}`));
  for (const path of [tlsPagePaths.index, tlsPagePaths.entry, tlsPagePaths.pgClient].concat(tlsPagePaths.workers)) if (!listed.has(path)) fail(`TLS page lacks ${path}`);
  if (!sameBytes(fileIdentity(join(tls, relative("tls", tlsPagePaths.pgClient))), fileIdentity(join(sourceRoot, TLS_PG_CLIENT)))) fail("delivered pg client differs from the selected source");
  for (const input of receipt.inputs) requireInput(sourceRoot, input);
  requireResolvedRelay(tls, actual);
  return receipt;
}

if (import.meta.main) {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error("Usage: bun scripts/c1/tls-page.ts NEW_TLS_DIRECTORY");
  const sourceRoot = process.cwd();
  const { buildBrowserEntries }: typeof import("../browser-build.ts") = await import("../browser-build.ts");
  await prepareTlsPage(sourceRoot, cleanSource(sourceRoot), resolve(target), (entries, outdir, options) => buildBrowserEntries(entries, outdir, options));
}
