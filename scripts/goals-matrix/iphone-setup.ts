import type { NativeCommand } from "./iphone-cleanup";
import { ordinarySnapshot, ownedTabClose, proveTabClosed, safariNodes, visibleOwnedTab } from "./iphone-tab-snapshot";
import { object } from "./evidence";
import { admit, type Admission } from "./scope";

type Nodes = ReturnType<typeof safariNodes>;
type Node = Nodes[number];

function ordinaryGroup(nodes: Nodes) {
  const groups = nodes.filter(node => node.kind === "button" && node.identifier === "CapsuleTabGroup");
  const ordinary = groups.filter(node => typeof node.label === "string" && /^\d+ Tabs?, Tab Group$/.test(node.label));
  if (ordinary.length !== 1 || groups.filter(node => node.selected === true).length !== 1) throw new Error("Cannot identify one ordinary Safari tab group and its selection before navigation");
  ref(ordinary[0]!);
  return ordinary[0]!;
}

function ref(node: Node): string {
  if (typeof node.index !== "number" || !Number.isSafeInteger(node.index) || typeof node.ref !== "string" || !/^e\d+(?:~s\d+)?$/.test(node.ref)) throw new Error("Missing Safari setup target ref");
  return "@" + node.ref;
}

function textTarget(nodes: Nodes): Node {
  const targets = nodes.filter(node => {
    if (node.kind !== "text" || typeof node.label !== "string" || !/^\d+ Tabs?$/.test(node.label) || node.enabled !== true || node.hittable !== true) return false;
    const parent = nodes.find(parent => parent.index === node.parentIndex && parent.kind === "other" && parent.identifier === "CapsuleTabGroup");
    return parent !== undefined && nodes.some(strip => strip.index === parent.parentIndex && strip.identifier === "ScrollingCapsuleCollectionView");
  });
  const target = targets[0];
  if (!target || targets.some(node => targetKey(nodes, node) !== targetKey(nodes, target))) throw new Error("Cannot identify one ordinary Safari tab-group target before navigation");
  return target;
}

function targetKey(nodes: Nodes, node: Node): string {
  const rect = object(node.rect);
  const bounds = [rect.x, rect.y, rect.width, rect.height];
  if (bounds.some(value => typeof value !== "number" || !Number.isFinite(value)) || Number(rect.width) <= 0 || Number(rect.height) <= 0) throw new Error("Missing Safari tab-group target bounds");
  const parent = nodes.find(parent => parent.index === node.parentIndex);
  if (typeof parent?.parentIndex !== "number" || !Number.isSafeInteger(parent.parentIndex)) throw new Error("Missing Safari tab-group strip identity");
  return JSON.stringify([node.label, parent.parentIndex].concat(bounds));
}

function safariControl(nodes: Nodes, kind: string, identifier: string): Node | undefined {
  const matches = nodes.filter(node => node.kind === kind && node.identifier === identifier);
  if (matches.length !== 1 || matches[0]?.enabled !== true || matches[0].hittable !== true) return;
  return matches[0];
}

function hasMoreMenu(nodes: Nodes): boolean {
  return nodes.some(node => node.identifier === "TabBarMoreMenu");
}

export function iphoneSafari(command: NativeCommand, admission: Admission) {
  async function snapshot(target?: string): Promise<Nodes> {
    const read = { command: "snapshot", input: { interactiveOnly: true } };
    const steps = target === undefined ? [read] : [
      { command: "press", input: { target: { kind: "ref", ref: target }, settle: true } }, read,
    ];
    const output = await command(["batch", "--steps", JSON.stringify(steps), "--on-error", "stop", "--json"], admit(admission), admission.signal);
    admit(admission);
    return safariNodes(output, steps.map(step => step.command));
  }
  async function overview(): Promise<Nodes> {
    await command(["open", "com.apple.mobilesafari"], admit(admission), admission.signal);
    let nodes = await snapshot();
    if (nodes.some(node => node.identifier === "CapsuleTabGroup")) return nodes;
    for (let attempt = 0; attempt < 2 && !hasMoreMenu(nodes); attempt++) {
      const more = safariControl(nodes, "button", "MoreMenuButton");
      if (!more) throw new Error("Cannot identify Safari More before ordinary tab-group setup");
      nodes = await snapshot(ref(more));
    }
    const allTabs = safariControl(nodes, "cell", "TabOverviewButton");
    if (!hasMoreMenu(nodes) || !allTabs) throw new Error("Safari More menu did not expose its All Tabs control");
    return snapshot(ref(allTabs));
  }
  async function ordinary(nodes: Nodes): Promise<Nodes> {
    const hasButtons = nodes.some(node => node.kind === "button" && node.identifier === "CapsuleTabGroup");
    const ordinary = hasButtons ? ordinaryGroup(nodes) : textTarget(nodes);
    if (!hasButtons || ordinary.selected !== true) {
      nodes = await snapshot(ref(ordinary));
      const selected = ordinaryGroup(nodes);
      const expectedLabel = hasButtons ? ordinary.label : ordinary.label + ", Tab Group";
      if (selected.selected !== true || selected.label !== expectedLabel) throw new Error("Ordinary Safari tab group selection is unproved before navigation");
    }
    return nodes;
  }
  async function finish(nodes: Nodes): Promise<void> {
    const done = nodes.filter(node => node.kind === "button" && node.identifier === "DoneButton" && node.label === "Done");
    if (done.length !== 1) throw new Error("Cannot identify Safari Done before owned navigation");
    const page = await snapshot(ref(done[0]!));
    const overview = page.some(node => typeof node.identifier === "string" &&
      (node.identifier === "TabOverview" || node.identifier === "CapsuleTabGroup" || node.identifier.startsWith("TabOverviewItemView?")));
    if (overview) throw new Error("Safari tab overview exit is unproved before navigation");
  }
  async function privateGroup(nodes: Nodes): Promise<Nodes> {
    const groups = nodes.filter(node => node.kind === "button" && node.identifier === "CapsuleTabGroup" && node.label === "Private, Tab Group");
    if (groups.length !== 1) throw new Error("Cannot identify one Private Safari tab group for owned cleanup");
    return snapshot(ref(groups[0]!));
  }
  return { overview, ordinary, finish, privateGroup, snapshot };
}

type StaleTabs = { titles: Set<string>; closed(title: string): Promise<void> };

export async function prepareIphoneSafari(command: NativeCommand, admission: Admission, stale?: StaleTabs): Promise<void> {
  const safari = iphoneSafari(command, admission);
  let nodes = await safari.ordinary(await safari.overview());
  if (stale?.titles.size) nodes = await closeVisibleStaleTabs(safari, nodes, stale);
  await safari.finish(nodes);
}

async function closeVisibleStaleTabs(safari: ReturnType<typeof iphoneSafari>, nodes: Nodes, stale: StaleTabs): Promise<Nodes> {
  let before = ordinarySnapshot(nodes);
  for (let title = visibleOwnedTab(before, stale.titles); title !== undefined; title = visibleOwnedTab(before, stale.titles)) {
    nodes = await safari.snapshot(ownedTabClose(before, title));
    const after = ordinarySnapshot(nodes);
    proveTabClosed(before, after, title);
    await stale.closed(title);
    stale.titles.delete(title);
    before = after;
  }
  return nodes;
}
