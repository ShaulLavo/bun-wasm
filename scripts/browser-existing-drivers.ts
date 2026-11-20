import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowIdentity, type CoverageEngine } from "./browser-guest-catalogue";
import type { RowEvidence } from "./browser-guest-regression";
import type { BrowserGuestContext } from "./browser-guest-wrapper";
import { hash } from "./guest-source-manifest";

type ExistingOwner = "installer-links" | "subprocess" | "preview-websocket" | "tools-integrity";
const drivers = { "installer-links": "browser-installer-links.ts", subprocess: "browser-subprocess.ts",
  "preview-websocket": "browser-net.mjs", "tools-integrity": "browser-tools.ts" } satisfies Record<ExistingOwner, string>;

export function existingDriverCommand(owner: ExistingOwner, context: BrowserGuestContext, engine: CoverageEngine) {
  if (!context.engines.includes(engine) || !context.regression.expected.some(row => row.group === owner && row.engine === engine)) throw new Error("Unselected driver engine");
  const command: [string, ...string[]] = [process.execPath, join(context.repository, "web/tests", drivers[owner]), context.leg];
  if (owner === "subprocess") command.push(`--engine=${engine}`, "--repeat=1");
  if (owner === "tools-integrity") command.push(`--engine=${engine}`, `--root=${context.artifact.site}`);
  const env = { ...context.env };
  if (owner === "installer-links" || owner === "preview-websocket") env.ENGINES = engine;
  return { command, env, cwd: join(context.repository, "web") };
}

function markers(owner: Exclude<ExistingOwner, "tools-integrity">, browser: string, engine: CoverageEngine): string[] {
  const slash = `${browser}/${engine}`, space = `${browser} ${engine}`;
  if (owner === "installer-links") return [`ok ${slash}: bin warnings, lock, bun run, script, bunx, fatal non-link error`, "1 passed, 0 failed"];
  if (owner === "preview-websocket") return [`ok   ${slash}: preview WebSocket preserves browser Origin and Host`,
    `ok   ${slash}: preview gone after foreground teardown`, `ok   ${slash}: no page errors`, "all passed"];
  return [`ok ${space} #1: Bun/Node subprocess APIs, nested workers, large stdin, cwd, files, timeout`].concat([
    "current executable survives missing or cross-engine PATH in spawn, fork and Worker",
    "invalid stdin conversion, synchronous EPIPE and Node stdin destroy EOF",
    "configuration capacity, limits, ancestry, cwd and cleanup", "closed child stdout/stderr reports EPIPE and exits",
    "pipe-write-order.ts", "pipe-stdin-race.ts", "isolated Worker guests, transfers, lifecycle, nested workers, termination and stdio",
  ].map(marker => `ok ${space}: ${marker}`));
}
function toolsMarkers(context: BrowserGuestContext, engine: CoverageEngine, lines: readonly string[]): boolean {
  const records: unknown[] = lines.filter(line => line.startsWith('{"coverage":"tools-integrity"')).map(line => JSON.parse(line));
  if (records.length !== 2) return false;
  const [negative, complete] = records;
  const expected = context.artifact.programs.get("bun-tools.wasm"), received = context.artifact.programs.get("bun.wasm");
  if (!expected || !received || !negative || typeof negative !== "object" || !complete || typeof complete !== "object") return false;
  return "phase" in negative && negative.phase === "wrong-payload" && "browser" in negative && negative.browser === context.leg
    && "engine" in negative && negative.engine === engine && "exit" in negative && negative.exit === 126
    && "expected" in negative && negative.expected === hash(expected) && "received" in negative && negative.received === hash(received)
    && "compileCount" in negative && negative.compileCount === 0 && "cacheHit" in negative && negative.cacheHit === false
    && "phase" in complete && complete.phase === "complete" && "browser" in complete && complete.browser === context.leg
    && "engine" in complete && complete.engine === engine;
}

/** Read the full log before the recorder retains its tail. Exit zero supplies no row evidence. */
export function existingDriverEvidence(owner: ExistingOwner, context: BrowserGuestContext, engine: CoverageEngine, log: string): RowEvidence[] {
  const lines = readFileSync(log, "utf8").split(/\r?\n/);
  const passed = owner === "tools-integrity" ? toolsMarkers(context, engine, lines)
    : markers(owner, context.leg, engine).every(marker => lines.includes(marker));
  return context.regression.expected.filter(row => row.group === owner && row.engine === engine).map(row => ({ id: rowIdentity(row),
    status: passed ? "passed" : "not-run", detail: passed ? "Original driver assertions and complete success markers passed" : "Missing original driver success markers" }));
}

export async function executeExistingBrowserDriver(owner: ExistingOwner, context: BrowserGuestContext): Promise<void> {
  const errors: unknown[] = [];
  for (const engine of context.engines) {
    if (!context.regression.safeToReuse || context.signal.aborted) break;
    try {
      await context.regression.runChild({ ...existingDriverCommand(owner, context, engine), signal: context.signal, hangSeconds: 900,
        rows: context.regression.expected.filter(row => row.engine === engine),
        evidence: result => existingDriverEvidence(owner, context, engine, result.log) });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Existing browser drivers failed");
}
