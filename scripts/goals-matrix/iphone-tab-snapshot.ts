import { object } from "./evidence";

type Button = { index: number; parentIndex: number | null; label: string; ref: string; identifier: string | null; selected: boolean };
type Overview = { buttons: Button[]; count: number };

export function batchSnapshot(output: string, commands: readonly string[]): Overview {
  const answer = object(JSON.parse(output));
  const data = object(answer.data);
  if (answer.success !== true || data.total !== commands.length || data.executed !== commands.length || !Array.isArray(data.results)) throw new Error("Incomplete native cleanup batch");
  const results = data.results.map(object);
  if (results.length !== commands.length || results.some((row, index) => row.ok !== true || row.command !== commands[index] || row.step !== index + 1)) throw new Error("Unexpected native cleanup batch results");
  const snapshot = object(results.at(-1)?.data);
  if (snapshot.appBundleId !== "com.apple.mobilesafari" || snapshot.truncated !== false || !Array.isArray(snapshot.nodes)) throw new Error("Missing Safari cleanup snapshot");
  const buttons = snapshot.nodes.map(object).filter(node => node.kind === "button").map(button);
  const groups = buttons.filter(node => node.selected === true && /^\d+ Tabs?, Tab Group$/.test(node.label));
  if (groups.length !== 1) throw new Error("Cannot identify Safari tab count");
  return { buttons, count: Number.parseInt(groups[0]!.label, 10) };
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
  if (after.count !== before.count - 1 || remaining.includes(title) || JSON.stringify(remaining) !== JSON.stringify(expected)) throw new Error("Task Safari tab closure is unproved");
}
