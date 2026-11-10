// Who owns the JSC parser reserve when a parent and its Worker child share one memory group
// (docs/stack-limits.md). The guest half is tests/fixtures/shared-wasm-memory/parser-reserve-ownership.ts;
// this is the host half both browser harnesses use.
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { chainOwnership, reserveSiteChains, type ChainOwnership } from "../../scripts/stack-measurement.ts";
import { jscParserReserve, jscStackBudgets, stackHost, type PageFacts } from "../src/engine-stack-budget.ts";

export const OWNERSHIP_ENTRY = "parser-reserve-ownership.ts";
const DEPTH = 4096;

export interface PageHost { readonly name: string; readonly budget: string; readonly reserve: string | null }

/** The host row this page selects, from what the page itself reports. */
export async function pageHost(page: Page, browser: string): Promise<PageHost> {
  const facts: PageFacts & { userAgent: string } = await page.evaluate(() => ({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }));
  const stack = browser === "chromium" ? "Error\n    at page" : "";
  const host = stackHost(stack, facts.userAgent, facts);
  return { name: host, budget: jscStackBudgets[host], reserve: jscParserReserve(stack, facts.userAgent, facts) ?? null };
}

export function deeper(shallow: Record<string, number>, deep: Record<string, number>, what: string): void {
  for (const mode of reserveSiteChains) assert.ok(deep[mode]! > shallow[mode]!, `${what}: ${mode} ${deep[mode]} is not above ${shallow[mode]}`);
}

function records(stdout: string): Map<string, ChainOwnership> {
  const cases = new Map<string, ChainOwnership>();
  for (const line of stdout.split("\n").filter(entry => entry.startsWith("ownership-case "))) {
    const record: { name: string; code: number | null; output: string } = JSON.parse(line.slice("ownership-case ".length));
    assert.equal(record.code, 0, `${record.name}: the parent exited ${record.code}`);
    cases.set(record.name, chainOwnership(decodeURIComponent(record.output), DEPTH));
  }
  return cases;
}

function named(cases: Map<string, ChainOwnership>, name: string): ChainOwnership {
  const record = cases.get(name);
  assert.ok(record, `no ownership record for ${name}`);
  assert.deepEqual(record.after, record.before, `${name}: the parent after its child exited`);
  return record;
}

/**
 * Each context shows its own value: a child with another explicit value, a default child under a
 * reduced parent, and a child that inherits. Engines other than JSC must ignore the value entirely.
 */
export function assertOwnership(stdout: string, kind: string, host: PageHost): void {
  const cases = records(stdout);
  const explicit = named(cases, "explicit"), defaulted = named(cases, "default-child");
  const inherited = named(cases, "inherited"), sameValue = named(cases, "same-value");
  assert.equal(explicit.child.settings.parserReserve, "1024");
  assert.equal(inherited.child.settings.parserReserve, "1536", "a child with no explicit value inherits its parent's");
  assert.equal(sameValue.child.settings.parserReserve, "1536");
  assert.deepEqual(inherited.child.capacities, sameValue.child.capacities, "an inherited value behaves as the same explicit value");
  assert.deepEqual(inherited.before, explicit.before, "the same parent value in two groups");
  if (kind !== "jsc") {
    assert.equal(defaulted.child.settings.parserReserve, null, `${kind} was handed the JSC parser reserve`);
    assert.deepEqual(explicit.child.capacities, sameValue.child.capacities, `${kind} must ignore the JSC parser reserve`);
    assert.deepEqual(explicit.before, sameValue.before, `${kind} must ignore the JSC parser reserve`);
    return;
  }
  assert.equal(defaulted.child.settings.parserReserve, host.reserve, "a child without the key gets the host's default");
  deeper(explicit.before, explicit.child.capacities, "a child at 1024 under a parent at 1536");
  deeper(defaulted.child.capacities, defaulted.before, "a default child under a parent at 1024");
  deeper(sameValue.before, sameValue.child.capacities, "a child at 1536 under a parent at 2048");
  deeper(sameValue.before, explicit.before, "parents at 2048 and 1536");
}
