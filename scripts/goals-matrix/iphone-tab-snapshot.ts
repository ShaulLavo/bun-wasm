import { object } from "./evidence";

type Button = { index: number; parentIndex: number | null; label: string; ref: string; identifier: string | null; selected: boolean; rect: unknown };
type Overview = { buttons: Button[] } & ({ group: "ordinary"; count: number } | { group: "private" });

export function safariNodes(output: string, commands: readonly string[]): Record<string, unknown>[] {
  return safariBatch(output, commands).nodes;
}

export function safariBatch(output: string, commands: readonly string[]) {
  const answer = object(JSON.parse(output));
  const data = object(answer.data);
  if (answer.success !== true || data.total !== commands.length || data.executed !== commands.length || !Array.isArray(data.results)) throw new Error("Incomplete native cleanup batch");
  const results = data.results.map(object);
  if (results.length !== commands.length || results.some((row, index) => row.ok !== true || row.command !== commands[index] || row.step !== index + 1)) throw new Error("Unexpected native cleanup batch results");
  const snapshot = object(results.at(-1)?.data);
  if (snapshot.appBundleId !== "com.apple.mobilesafari" || snapshot.truncated !== false || !Array.isArray(snapshot.nodes)) throw new Error("Missing Safari cleanup snapshot");
  return { nodes: snapshot.nodes.map(object), press: commands[0] === "press" ? results[0]?.data : undefined };
}

export function batchSnapshot(output: string, commands: readonly string[]): Overview {
  return ordinarySnapshot(safariNodes(output, commands));
}

export function ordinarySnapshot(nodes: Record<string, unknown>[]): Overview {
  const buttons = nodes.filter(node => node.kind === "button").map(button);
  const groups = buttons.filter(node => node.selected === true && /^\d+ Tabs?, Tab Group$/.test(node.label));
  if (groups.length !== 1) throw new Error("Cannot identify Safari tab count");
  if (buttons.some(node => node.identifier === "CapsuleTabGroup" && node.selected && node !== groups[0])) throw new Error("Cannot identify Safari tab count");
  return { group: "ordinary", buttons, count: Number.parseInt(groups[0]!.label, 10) };
}

export function privateSnapshot(nodes: Record<string, unknown>[]): Overview {
  const buttons = nodes.filter(node => node.kind === "button").map(button);
  const selected = buttons.filter(node => node.identifier === "CapsuleTabGroup" && node.selected);
  if (selected.length !== 1 || selected[0]!.label !== "Private, Tab Group") throw new Error("Private Safari group selection is unproved");
  return { group: "private", buttons };
}

export function hasOwnedTab(overview: Overview, title: string): boolean {
  return tabs(overview).some(node => node.label === title);
}

export function visibleOwnedTab(overview: Overview, titles: ReadonlySet<string>): string | undefined {
  const cards = tabs(overview);
  return cards.find(card => titles.has(card.label) && cards.filter(other => other.label === card.label).length === 1)?.label;
}

export function proveTabsUnchanged(before: Overview, after: Overview): void {
  if (before.group !== "ordinary" || after.group !== "ordinary" || before.count !== after.count || !sameLabels(tabs(before), tabs(after))) throw new Error("Ordinary Safari tabs changed during Private cleanup");
}

function button(node: Record<string, unknown>): Button {
  if (typeof node.index !== "number" || !Number.isSafeInteger(node.index) || typeof node.label !== "string" || typeof node.ref !== "string" || !/^e\d+(?:~s\d+)?$/.test(node.ref)) throw new Error("Malformed Safari cleanup button");
  return { index: node.index, parentIndex: typeof node.parentIndex === "number" ? node.parentIndex : null, label: node.label, ref: "@" + node.ref, rect: node.rect,
    identifier: typeof node.identifier === "string" ? node.identifier : null, selected: node.selected === true };
}

function tabs(overview: Overview): Button[] {
  return overview.buttons.filter(node => node.identifier?.startsWith("TabOverviewItemView?"));
}

function complete(overview: Overview): boolean {
  return overview.group === "ordinary" && tabs(overview).length === overview.count;
}

function sameLabels(before: Button[], after: Button[]): boolean {
  return JSON.stringify(before.map(node => node.label).sort()) === JSON.stringify(after.map(node => node.label).sort());
}

function includesLabels(cards: Button[], expected: Button[]): boolean {
  const available = new Map<string, number>();
  for (const { label } of cards) available.set(label, (available.get(label) ?? 0) + 1);
  for (const { label } of expected) {
    const count = available.get(label) ?? 0;
    if (count === 0) return false;
    available.set(label, count - 1);
  }
  return true;
}

function ownedButtons(overview: Overview, title: string) {
  const matches = tabs(overview).filter(node => node.label === title);
  if (matches.length !== 1) throw new Error("Cannot identify the task's Safari tab for cleanup");
  const closes = overview.buttons.filter(node => node.label === "Close" && node.parentIndex === matches[0]!.index);
  if (closes.length !== 1) throw new Error("Cannot identify the task's Safari Close button");
  return { card: matches[0]!, close: closes[0]! };
}

export function ownedTabClose(overview: Overview, title: string): string {
  return ownedButtons(overview, title).close.ref;
}

export function proveTabClosed(before: Overview, after: Overview, title: string, press?: unknown): void {
  const fail = () => new Error("Task Safari tab closure is unproved");
  const original = tabs(before), remaining = tabs(after);
  if (original.filter(node => node.label === title).length !== 1 || hasOwnedTab(after, title) || after.group !== before.group) throw fail();
  if (before.group === "ordinary" && (after.group !== "ordinary" || after.count !== before.count - 1)) throw fail();
  const expected = original.filter(node => node.label !== title);
  if (before.group === "private" || (complete(before) && complete(after))) {
    if (!sameLabels(expected, remaining)) throw fail();
    return;
  }
  // Offscreen cards cannot prove the result of the press. Verify the actual close hit and its settled removal.
  if (!includesLabels(remaining, expected) || !pressedOwnedClose(ownedButtons(before, title), press)) throw fail();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? object(value) : {};
}

function pressedOwnedClose({ card, close }: ReturnType<typeof ownedButtons>, value: unknown): boolean {
  const press = record(value), resolution = record(press.resolution), settle = record(press.settle);
  if (press.targetKind !== "ref" || press.ref !== close.ref.slice(1) || press.refLabel !== "Close") return false;
  if (resolution.source !== "ref" || resolution.phase !== "pre-action" || resolution.kind !== "exact" || settle.settled !== true) return false;
  const bounds = record(close.rect);
  if (!inside(press.x, bounds.x, bounds.width) || !inside(press.y, bounds.y, bounds.height)) return false;
  const lines = record(settle.diff).lines;
  const expected = `${card.ref} [button] ${JSON.stringify(card.label)}`;
  return Array.isArray(lines) && lines.some(line => { const row = record(line); return row.kind === "removed" && row.text === expected; });
}

function inside(point: unknown, origin: unknown, length: unknown): boolean {
  return typeof point === "number" && typeof origin === "number" && typeof length === "number"
    && Number.isFinite(length) && length > 0 && point >= origin && point < origin + length;
}
