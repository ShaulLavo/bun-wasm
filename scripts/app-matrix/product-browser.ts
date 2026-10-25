import type { FeatureProbe, ProductCheck, SourceEdit } from "./product-types";

interface Locator {
  filter(options: { hasText: string }): Locator;
  waitFor(options: { timeout: number }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
}
interface Response {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  headers(): Record<string, string>;
}
interface Socket {
  on(event: "framereceived", listener: (event: { payload: unknown }) => void): unknown;
}
export interface ProductPage {
  locator(selector: string): Locator;
  goto(url: string, options: { timeout: number }): Promise<Response | null>;
  on(event: "websocket", listener: (socket: Socket) => void): unknown;
  off(event: "websocket", listener: (socket: Socket) => void): unknown;
}
export interface GuestSource {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
}
export interface Observation {
  stage: string;
  status: "pass" | "fail" | "blocked";
  assertion?: string;
  blocker?: string;
}

export function observeProductTraffic(page: ProductPage) {
  let frames = 0;
  const listener = (socket: Socket) => socket.on("framereceived", () => { frames++; });
  page.on("websocket", listener);
  return { count: () => frames, close: () => { page.off("websocket", listener); } };
}

async function hotEdit(page: ProductPage, source: GuestSource, selector: string, edit: SourceEdit, traffic: { count(): number }, timeout: number): Promise<string> {
  const original = await source.read(edit.path);
  if (original === null || !original.includes(edit.search)) throw new Error(`HMR source marker missing in ${edit.path}`);
  if (!edit.search || edit.search === edit.replacement) throw new Error("HMR edit must change a nonempty source marker");
  const before = traffic.count();
  try {
    await source.write(edit.path, original.replace(edit.search, edit.replacement));
    await page.locator(selector).filter({ hasText: edit.replacement }).waitFor({ timeout });
    if (traffic.count() <= before) throw new Error("Edited content appeared without a development WebSocket update");
    return `Guest source edit rendered ${JSON.stringify(edit.replacement)} without a manual page reload`;
  } finally { await source.write(edit.path, original); }
}

async function featureProbe(page: ProductPage, base: string, probe: FeatureProbe, timeout: number): Promise<string> {
  const response = await page.goto(new URL(probe.path.replace(/^\/+/, ""), base.endsWith("/") ? base : base + "/").href, { timeout });
  if (!response) throw new Error(`No response for ${probe.path}`);
  if (probe.kind === "response") {
    if (response.status() !== probe.status) throw new Error(`${probe.path}: expected HTTP ${probe.status}, received ${response.status()}`);
    if (probe.text !== undefined && !(await response.text()).includes(probe.text)) throw new Error(`${probe.path}: response marker missing`);
    if (probe.header && response.headers()[probe.header.name.toLowerCase()] !== probe.header.value) throw new Error(`${probe.path}: response header ${probe.header.name} differs`);
    return `${probe.path}: HTTP ${probe.status} and requested body/header assertions`;
  }
  if (!response.ok()) throw new Error(`${probe.path}: HTTP ${response.status()}`);
  if (probe.kind === "action") await page.locator(probe.button).click({ timeout });
  await page.locator(probe.selector).filter({ hasText: probe.text }).waitFor({ timeout });
  return `${probe.path}: ${probe.kind} rendered ${JSON.stringify(probe.text)}`;
}

async function observe(stage: string, operation: () => Promise<string>): Promise<Observation> {
  try { return { stage, status: "pass", assertion: await operation() }; }
  catch (error) { return { stage, status: "fail", blocker: String(error) }; }
}

export async function productObservations(page: ProductPage, base: string, check: ProductCheck, source: GuestSource, traffic: { count(): number }, timeout: number): Promise<Observation[]> {
  if (check.kind !== "page" && check.kind !== "http") return [];
  const results: Observation[] = [];
  if (check.kind === "page" && check.hmr) {
    const edit = check.hmr;
    results.push(await observe("hmr", () => hotEdit(page, source, check.selector, edit, traffic, timeout)));
  }
  for (const probe of check.probes ?? []) results.push(await observe(probe.id, () => featureProbe(page, base, probe, timeout)));
  return results;
}

export function expectedObservations(check: ProductCheck): string[] {
  if (check.kind !== "page" && check.kind !== "http") return [];
  const hmr = check.kind === "page" && check.hmr ? ["hmr"] : [];
  return hmr.concat(Array.from(check.probes ?? [], probe => probe.id));
}

export function completeObservations(check: ProductCheck, observations: readonly Observation[], prerequisite: { status: string; blocker?: string }): Observation[] {
  const found = new Map(observations.map(row => [row.stage, row]));
  return expectedObservations(check).map(stage => found.get(stage) ?? {
    stage, status: "blocked", blocker: prerequisite.blocker ?? `Page stage ${prerequisite.status}; feature did not run`,
  });
}
