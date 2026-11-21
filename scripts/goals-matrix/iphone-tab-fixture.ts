import { object } from "./evidence";

type FixtureButton = { kind: string; index: number; parentIndex: number; label: string; ref: string; identifier?: string; selected?: boolean };
export function tabOverview(labels: string[], count = labels.length) {
  const nodes: FixtureButton[] = labels.flatMap((label, index) => [
    { kind: "button", index: index * 2, parentIndex: 90, label, ref: `e${index * 2 + 1}`, identifier: "TabOverviewItemView?IsPinned=false" },
    { kind: "button", index: index * 2 + 1, parentIndex: index * 2, label: "Close", ref: `e${index * 2 + 2}` },
  ]);
  nodes.push({ kind: "button", index: 90, parentIndex: 99, label: `${count} Tabs, Tab Group`, ref: "e99", identifier: "CapsuleTabGroup", selected: true });
  nodes.push({ kind: "button", index: 91, parentIndex: 99, label: "Done", ref: "e100", identifier: "DoneButton" });
  return { appBundleId: "com.apple.mobilesafari", truncated: false, nodes };
}

export function tabPage() {
  return { appBundleId: "com.apple.mobilesafari", truncated: false,
    nodes: [{ kind: "button", index: 92, parentIndex: 99, label: "More", ref: "e101", identifier: "MoreMenuButton", enabled: true, hittable: true }] };
}

export function tabMoreMenu() {
  return { appBundleId: "com.apple.mobilesafari", truncated: false, nodes: [
    { kind: "other", index: 1, parentIndex: 0, ref: "e2", identifier: "TabBarMoreMenu" },
    { kind: "collection", index: 2, parentIndex: 1, ref: "e3" },
    { kind: "cell", index: 3, parentIndex: 2, label: "All Tabs", ref: "e4", identifier: "TabOverviewButton", enabled: true, hittable: true },
  ] };
}

export function tabBatch(snapshot: unknown, commands = ["press", "snapshot"]) {
  return JSON.stringify({ success: true, data: { total: commands.length, executed: commands.length, results: commands.map((command, index) => ({ step: index + 1, command, ok: true, data: command === "snapshot" ? snapshot : {} })) } });
}

export function tabAgentScript(config: { closed: string; title: string; unrelated: string; log?: string; hangOnCleanup?: boolean }) {
  return `#!${process.execPath}
import {appendFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
const config=${JSON.stringify(config)}, args=process.argv.slice(2), navigated=config.closed+'.navigated';
if(config.log)await appendFile(config.log,JSON.stringify({args,pid:process.pid})+'\\n');
if(args[0]==='open'&&args.length>2)await writeFile(navigated,'opened');
if(config.hangOnCleanup&&args[0]==='open'&&args.length===2&&existsSync(navigated))await Bun.sleep(2000);
if(args[0]==='batch'){
 const steps=JSON.parse(args[2]), target=steps[0].input.target;
 if(target?.ref==='@e2')await writeFile(config.closed,'closed');
 const labels=existsSync(navigated)&&!existsSync(config.closed)?[config.title,config.unrelated]:[config.unrelated];
 const page=target?.ref==='@e100'||steps[0].command==='snapshot'&&existsSync(navigated);
 const snapshot=target?.ref==='@e101'?(${tabMoreMenu.toString()})():page?(${tabPage.toString()})():(${tabOverview.toString()})(labels);
 console.log((${tabBatch.toString()})(snapshot,steps.map(step=>step.command)));
}else console.log('@e1 [button] "Increment"');
`;
}

export function cleanupGroups(ownedGroup: "private" | "ordinary", options: { overview?: boolean; ignoreClose?: boolean } = {}) {
  let selected: "private" | "ordinary" = "private", overview = options.overview ?? false, menu = false;
  const cards = { private: ["Unrelated private"], ordinary: ["Unrelated ordinary"] };
  cards[ownedGroup].unshift("Goals owned");
  const closed: string[] = [];
  const snapshot = () => {
    if (menu) return tabMoreMenu();
    if (!overview) return tabPage();
    const result = tabOverview(cards[selected], cards.ordinary.length);
    result.nodes.find(node => node.identifier === "CapsuleTabGroup")!.selected = selected === "ordinary";
    result.nodes.push({ kind: "button", index: 98, parentIndex: 99, label: "Private, Tab Group", ref: "e98", identifier: "CapsuleTabGroup", selected: selected === "private" });
    return result;
  };
  function input(step: Record<string, unknown>) {
    if (step.command !== "press") return;
    const target = object(object(step.input).target);
    if (target.ref === "@e101" && !overview && !menu) { menu = true; return; }
    if (target.ref === "@e4" && menu) { menu = false; overview = true; return; }
    if (target.ref === "@e99") { selected = "ordinary"; return; }
    if (target.ref === "@e98") { selected = "private"; return; }
    if (target.ref === "@e100") { overview = false; return; }
    if (target.ref !== "@e2" || cards[selected][0] !== "Goals owned") throw new Error("Refused to close an unrelated tab");
    if (options.ignoreClose) return;
    closed.push(cards[selected].shift()!);
  }
  const command = async (args: string[]) => {
    if (args[0] !== "batch") return "Opened";
    const steps: unknown = JSON.parse(args[2]!);
    if (!Array.isArray(steps)) throw new Error("Expected native steps");
    const rows = steps.map(object);
    rows.forEach(input);
    return tabBatch(snapshot(), rows.map(row => String(row.command)));
  };
  return { command, cards, closed, selected: () => selected, inOverview: () => overview };
}
