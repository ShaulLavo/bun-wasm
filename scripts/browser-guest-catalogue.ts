const coverageEngines = ["browser", "quickjs", "jsc"] as const;
export type CoverageEngine = typeof coverageEngines[number];
type CoverageBrowser = "chromium" | "firefox" | "webkit";
export type CoverageLeg = Exclude<CoverageBrowser, "firefox">;

// Exact identities from the 2026-11-14 source audit. Controls have separate records.
export const browserGuestRows = [
  {"group": "installer-links", "browser": "chromium", "engine": "browser", "case": "bun run dev tail"},
  {"group": "installer-links", "browser": "chromium", "engine": "quickjs", "case": "bun run dev tail"},
  {"group": "installer-links", "browser": "chromium", "engine": "jsc", "case": "bun run dev tail"},
  {"group": "installer-links", "browser": "webkit", "engine": "browser", "case": "bun run dev tail"},
  {"group": "installer-links", "browser": "webkit", "engine": "quickjs", "case": "bun run dev tail"},
  {"group": "installer-links", "browser": "webkit", "engine": "jsc", "case": "bun run dev tail"},
  {"group": "subprocess", "browser": "chromium", "engine": "quickjs", "case": "eight executable aliases and API completion"},
  {"group": "subprocess", "browser": "chromium", "engine": "jsc", "case": "eight executable aliases and API completion"},
  {"group": "subprocess", "browser": "chromium", "engine": "browser", "case": "eight executable aliases and API completion"},
  {"group": "subprocess", "browser": "webkit", "engine": "quickjs", "case": "eight executable aliases and API completion"},
  {"group": "subprocess", "browser": "webkit", "engine": "jsc", "case": "eight executable aliases and API completion"},
  {"group": "subprocess", "browser": "webkit", "engine": "browser", "case": "eight executable aliases and API completion"},
  {"group": "preview-websocket", "browser": "chromium", "engine": "browser", "case": "visible preview Origin and Host"},
  {"group": "preview-websocket", "browser": "chromium", "engine": "quickjs", "case": "visible preview Origin and Host"},
  {"group": "preview-websocket", "browser": "webkit", "engine": "browser", "case": "visible preview Origin and Host"},
  {"group": "preview-websocket", "browser": "webkit", "engine": "quickjs", "case": "visible preview Origin and Host"},
  {"group": "engine-interruption", "browser": "chromium", "engine": "quickjs", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "engine-interruption", "browser": "chromium", "engine": "jsc", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "engine-interruption", "browser": "firefox", "engine": "quickjs", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "engine-interruption", "browser": "firefox", "engine": "jsc", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "engine-interruption", "browser": "webkit", "engine": "quickjs", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "engine-interruption", "browser": "webkit", "engine": "jsc", "case": "runtimeProcess/page-kill sleepSync-default-SIGUSR1"},
  {"group": "worker-modules", "browser": "chromium", "engine": "browser", "case": "controlled atomic-transfer 20 repetitions"},
  {"group": "worker-modules", "browser": "chromium", "engine": "browser", "case": "uncontrolled descendant atomic-transfer"},
  {"group": "worker-modules", "browser": "webkit", "engine": "browser", "case": "controlled atomic-transfer 20 repetitions"},
  {"group": "worker-modules", "browser": "webkit", "engine": "browser", "case": "uncontrolled descendant atomic-transfer"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "direct bun run stdin-probe.ts"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "env bun run stdin-probe.ts"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "package sh -c cd stdin-script and bun run probe"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "shebang ./stdin-tool"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "printf pipe via env"},
  {"group": "terminal-stdin", "browser": "chromium", "engine": "browser", "case": "file redirection via env"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "direct bun run stdin-probe.ts"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "env bun run stdin-probe.ts"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "package sh -c cd stdin-script and bun run probe"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "shebang ./stdin-tool"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "printf pipe via env"},
  {"group": "terminal-stdin", "browser": "webkit", "engine": "browser", "case": "file redirection via env"},
  {"group": "tools-integrity", "browser": "chromium", "engine": "quickjs", "case": "intentional wrong tools payload exit/cache/compile outcome"},
  {"group": "tools-integrity", "browser": "chromium", "engine": "jsc", "case": "intentional wrong tools payload exit/cache/compile outcome"},
  {"group": "tools-integrity", "browser": "chromium", "engine": "browser", "case": "intentional wrong tools payload exit/cache/compile outcome"},
  {"group": "tools-integrity", "browser": "webkit", "engine": "quickjs", "case": "intentional wrong tools payload exit/cache/compile outcome"},
  {"group": "tools-integrity", "browser": "webkit", "engine": "jsc", "case": "intentional wrong tools payload exit/cache/compile outcome"},
  {"group": "tools-integrity", "browser": "webkit", "engine": "browser", "case": "intentional wrong tools payload exit/cache/compile outcome"},
] as const;
export type BrowserGuestRow = typeof browserGuestRows[number];
export type CoverageOwner = BrowserGuestRow["group"];
interface OwnerSelection { readonly owner: CoverageOwner; readonly engines: readonly CoverageEngine[] }
export type BrowserGuestSelection = readonly OwnerSelection[];

export const coverageOwners: readonly CoverageOwner[] = ["installer-links", "subprocess", "preview-websocket", "engine-interruption", "worker-modules", "terminal-stdin", "tools-integrity"];
export const coverageBatches = {
  "installer-links": "20-installer-links", subprocess: "21-subprocess-aliases",
  "preview-websocket": "22-preview-websocket-headers", "engine-interruption": "23-engine-interruption",
  "worker-modules": "24-worker-modules", "terminal-stdin": "25-terminal-stdin", "tools-integrity": "26-tools-integrity",
} as const satisfies Record<CoverageOwner, string>;
export const coverageWrappers = {
  "installer-links": "installer-links", subprocess: "subprocess-aliases",
  "preview-websocket": "preview-websocket-headers", "engine-interruption": "engine-interruption",
  "worker-modules": "worker-modules", "terminal-stdin": "terminal-stdin", "tools-integrity": "tools-integrity",
} as const satisfies Record<CoverageOwner, string>;

export function rowIdentity(row: BrowserGuestRow): string {
  return JSON.stringify([row.group, row.browser, row.engine, row.case]);
}
export function ownerEngines(owner: CoverageOwner): CoverageEngine[] {
  return coverageEngines.filter(engine => browserGuestRows.some(row => row.group === owner && row.engine === engine));
}
export const fullBrowserGuestSelection: BrowserGuestSelection = coverageOwners.map(owner => ({ owner, engines: ownerEngines(owner) }));
export const withoutJscBrowserGuestSelection: BrowserGuestSelection = coverageOwners.map(owner => ({ owner, engines: ownerEngines(owner).filter(engine => engine !== "jsc") }));

/** Parse serialized parent outputs without deriving a subset from available artifacts. */
export function parseBrowserGuestSelection(value: unknown): BrowserGuestSelection {
  if (!Array.isArray(value)) throw new Error("Missing coverage selection");
  const parsed = value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("owner" in item) || !("engines" in item) || !Array.isArray(item.engines)) throw new Error("Invalid coverage selection");
    const owner = coverageOwners.find(owner => owner === item.owner), supplied: unknown[] = item.engines;
    if (!owner) throw new Error("Unknown coverage owner");
    const engines = ownerEngines(owner).filter(engine => supplied.includes(engine));
    if (JSON.stringify(engines) !== JSON.stringify(supplied)) throw new Error(`Noncanonical selected engines: ${owner}`);
    return { owner, engines };
  });
  validateSelection(parsed);
  return parsed;
}
export function validateSelection(selection: BrowserGuestSelection): void {
  const owners = new Set<CoverageOwner>();
  for (const { owner, engines } of selection) {
    if (!coverageOwners.includes(owner) || owners.has(owner)) throw new Error(`Unknown or duplicate coverage owner: ${owner}`);
    owners.add(owner);
    if (!engines.length || new Set(engines).size !== engines.length || engines.some(engine => !ownerEngines(owner).includes(engine))) throw new Error(`Invalid selected engines for ${owner}`);
  }
}
export function expectedBrowserGuestRows(selection: BrowserGuestSelection, leg?: CoverageLeg): BrowserGuestRow[] {
  validateSelection(selection);
  return browserGuestRows.filter(row => selection.some(item => item.owner === row.group && item.engines.includes(row.engine))
    && (leg === undefined || row.browser === leg || leg === "chromium" && row.browser === "firefox"));
}
export function unionBrowserGuestSelections(...selections: readonly BrowserGuestSelection[]): BrowserGuestSelection {
  for (const selection of selections) validateSelection(selection);
  return coverageOwners.flatMap(owner => {
    const engines = ownerEngines(owner).filter(engine => selections.some(selection => selection.some(item => item.owner === owner && item.engines.includes(engine))));
    return engines.length ? [{ owner, engines }] : [];
  });
}
