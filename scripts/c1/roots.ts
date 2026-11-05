import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { C1Config } from "./contract.ts";
import { inside, physicalPath } from "./identity.ts";

/**
 * Writable roots each operation acquires, in two phases. Admission roots are
 * private scratch created before full input admission. Durable roots are
 * claimed only after admission passed; the first durable root is the
 * operation's record (report or qualification output), created first and
 * kept on every outcome. A refused root is never prepared or cleaned.
 */
type Operation ="check" | "run" | "rehearse" | "qualify";
export interface RootSpec { readonly name: string; readonly path: string; readonly retained: boolean }
export interface RootPlan {
  readonly operation: Operation;
  readonly admission: readonly RootSpec[];
  readonly durable: readonly RootSpec[];
  readonly browserTmp?: string;
}

/** machine-fleet: Chromium appends about 45 bytes for its singleton socket. */
export const BROWSER_TMPDIR_LIMIT = 48;
/** The longest scratch suffix a maintained Chromium runner nests under TMPDIR (the publication matrix). */
const BROWSER_SCRATCH_SUFFIX = "/bun-wasm-engine-interruption-XXXXXX";

export class RootError extends Error {}
/** The claim stopped at `refused`; only `created` belong to this invocation. */
export class ClaimRefused extends RootError {
  constructor(readonly refused: string, readonly created: readonly RootSpec[], cause: unknown) {
    super(`fresh root ${refused} could not be claimed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const scratch = (name: string, path: string): RootSpec => ({ name, path, retained: false });
const kept = (name: string, path: string): RootSpec => ({ name, path, retained: true });
export function runPlan(config: C1Config): RootPlan {
  const roots = config.roots.run;
  return { operation: "run", browserTmp: roots.browserTmp, admission: [scratch("private", roots.private)],
    durable: [kept("report", roots.report), kept("artifact", roots.artifact), scratch("browserTmp", roots.browserTmp)] };
}
export function rehearsePlan(config: C1Config): RootPlan {
  const roots = config.roots.rehearse;
  if (!roots) throw new RootError("config.roots.rehearse is required to rehearse");
  return { operation: "rehearse", browserTmp: roots.browserTmp, admission: [scratch("private", roots.private)],
    durable: [kept("report", roots.report), scratch("browserTmp", roots.browserTmp)] };
}
export function qualifyPlan(config: C1Config): RootPlan {
  const roots = config.roots.qualify;
  return { operation: "qualify", browserTmp: roots.browserTmp, admission: [scratch("private", roots.private)],
    durable: [kept("output", roots.output), scratch("browserTmp", roots.browserTmp)] };
}
/** Check admits inside one invocation-owned scratch directory and keeps nothing. */
export function checkPlan(path: string): RootPlan {
  return { operation: "check", admission: [scratch("scratch", path)], durable: [] };
}

function requireFresh(spec: RootSpec): void {
  if (lstatSync(spec.path, { throwIfNoEntry: false })) throw new RootError(`${spec.name} root already exists (or is a link): ${spec.path}`);
  const parent = dirname(spec.path);
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new RootError(`${spec.name} root parent is missing or not a directory: ${parent}`);
  if (realpathSync(parent) !== parent) throw new RootError(`${spec.name} root parent is not a physical path: ${parent}`);
}
function overlaps(a: string, b: string): boolean { return inside(a, b) || inside(b, a); }
/**
 * Every root is fresh under a physical parent, disjoint from every other root
 * and from every protected input (source, config, manifest, receipts, donors,
 * native roots, a retained rehearsal root), compared by physical path.
 * Runs before any write.
 */
export function validatePlan(plan: RootPlan, protectedPaths: readonly string[]): void {
  const roots = plan.admission.concat(plan.durable);
  for (const spec of roots) requireFresh(spec);
  const physical = roots.map(spec => ({ spec, path: physicalPath(spec.path) }));
  for (const [index, root] of physical.entries()) {
    const other = physical.slice(index + 1).find(candidate => overlaps(root.path, candidate.path));
    if (other) throw new RootError(`${root.spec.name} and ${other.spec.name} roots overlap`);
  }
  const inputs = protectedPaths.map(path => physicalPath(path));
  for (const root of physical) {
    const input = inputs.find(path => overlaps(root.path, path));
    if (input) throw new RootError(`${root.spec.name} root overlaps protected input ${input}`);
  }
  if (plan.browserTmp !== undefined) validateBrowserTmp(plan.browserTmp);
}
export function validateBrowserTmp(root: string): void {
  const bytes = Buffer.byteLength(root + BROWSER_SCRATCH_SUFFIX);
  if (bytes > BROWSER_TMPDIR_LIMIT) throw new RootError(`browser scratch root expands to ${bytes} bytes, over ${BROWSER_TMPDIR_LIMIT}: ${root}`);
}

/** Roots this invocation actually created, in creation order. */
export class Claimed {
  readonly created: RootSpec[] = [];
  /**
   * Exclusively create each root, mode 0700, never recursively. On refusal
   * the error lists every root this invocation created so far.
   */
  claim(specs: readonly RootSpec[]): void {
    for (const spec of specs) {
      try { mkdirSync(spec.path, { mode: 0o700 }); }
      catch (error) { throw new ClaimRefused(spec.path, this.created.slice(), error); }
      this.created.push(spec);
    }
  }
  path(name: string): string {
    const spec = this.created.find(candidate => candidate.name === name);
    if (!spec) throw new RootError(`root ${name} is not owned by this invocation`);
    return spec.path;
  }
  owns(name: string): boolean { return this.created.some(spec => spec.name === name); }
  /** Remove created, non-retained roots, newest first. Retained roots stay as evidence. */
  removeScratch(): string[] {
    const removed = this.created.filter(spec => !spec.retained).map(spec => spec.path).toReversed();
    for (const path of removed) rmSync(path, { recursive: true, force: true });
    return removed;
  }
}
