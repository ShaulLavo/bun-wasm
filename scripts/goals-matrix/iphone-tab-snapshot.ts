import { object } from "./evidence";

type Button = { index: number; parentIndex: number | null; label: string; ref: string; identifier: string | null; selected: boolean };
type Overview = { buttons: Button[] } & ({ group: "ordinary"; count: number } | { group: "private" });

export function safariNodes(output: string, commands: readonly string[]): Record<string, unknown>[] {
  const answer = object(JSON.parse(output));
  const data = object(answer.data);
  if (answer.success !== true || data.total !== commands.length || data.executed !== commands.length || !Array.isArray(data.results)) throw new Error("Incomplete native cleanup batch");
  const results = data.results.map(object);
  if (results.length !== commands.length || results.some((row, index) => row.ok !== true || row.command !== commands[index] || row.step !== index + 1)) throw new Error("Unexpected native cleanup batch results");
  const snapshot = object(results.at(-1)?.data);
  if (snapshot.appBundleId !== "com.apple.mobilesafari" || snapshot.truncated !== false || !Array.isArray(snapshot.nodes)) throw new Error("Missing Safari cleanup snapshot");
  return snapshot.nodes.map(object);
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

export function proveTabsUnchanged(before: Overview, after: Overview): void {
  const labels = (value: Overview) => tabs(value).map(node => node.label).sort();
  if (before.group !== "ordinary" || after.group !== "ordinary" || before.count !== after.count || JSON.stringify(labels(before)) !== JSON.stringify(labels(after))) throw new Error("Ordinary Safari tabs changed during Private cleanup");
}

function button(node: Record<string, unknown>): Button {
  if (typeof node.index !== "number" || !Number.isSafeInteger(node.index) || typeof node.label !== "string" || typeof node.ref !== "string" || !/^e\d+(?:~s\d+)?$/.test(node.ref)) throw new Error("Malformed Safari cleanup button");
  return { index: node.index, parentIndex: typeof node.parentIndex === "number" ? node.parentIndex : null, label: node.label, ref: "@" + node.ref,
    identifier: typeof node.identifier === "string" ? node.identifier : null, selected: node.selected === true };
}

function tabs(overview: Overview): Button[] {
  return overview.buttons.filter(node => node.identifier?.startsWith("TabOverviewItemView?"));
}

export function ownedTabClose(overview: Overview, title: string): string {
  const matches = tabs(overview).filter(node => node.label === title);
  if (matches.length !== 1) throw new Error("Cannot identify the task's Safari tab for cleanup");
  const closes = overview.buttons.filter(node => node.label === "Close" && node.parentIndex === matches[0]!.index);
  if (closes.length !== 1) throw new Error("Cannot identify the task's Safari Close button");
  return closes[0]!.ref;
}

export function proveTabClosed(before: Overview, after: Overview, title: string): void {
  const remaining = tabs(after).map(node => node.label).sort();
  const expected = tabs(before).filter(node => node.label !== title).map(node => node.label).sort();
  const countProved = before.group === "private" ? after.group === "private" : after.group === "ordinary" && after.count === before.count - 1;
  if (tabs(before).filter(node => node.label === title).length !== 1 || !countProved || remaining.includes(title) || JSON.stringify(remaining) !== JSON.stringify(expected)) throw new Error("Task Safari tab closure is unproved");
}
