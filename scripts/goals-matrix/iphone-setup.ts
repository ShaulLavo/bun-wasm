import type { NativeCommand } from "./iphone-cleanup";
import { safariNodes } from "./iphone-tab-snapshot";
import { object } from "./evidence";
import { admit, type Admission } from "./scope";

type Nodes = ReturnType<typeof safariNodes>;
type Node = Nodes[number];
type Step = { command: "press" | "snapshot"; input: Record<string, unknown> };

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

export function iphoneSafari(command: NativeCommand, admission: Admission) {
  const press = (node: Node): Step => ({ command: "press", input: { target: { kind: "ref", ref: ref(node) }, settle: true } });
  async function snapshot(steps: Step[] = []): Promise<Nodes> {
    const batch = steps.concat([{ command: "snapshot", input: { interactiveOnly: true } }]);
    const output = await command(["batch", "--steps", JSON.stringify(batch), "--on-error", "stop", "--json"], admit(admission), admission.signal);
    admit(admission);
    return safariNodes(output, batch.map(step => step.command));
  }
  async function overview(): Promise<Nodes> {
    await command(["open", "com.apple.mobilesafari"], admit(admission), admission.signal);
    let nodes = await snapshot();
    if (!nodes.some(node => node.identifier === "CapsuleTabGroup")) {
      const more = nodes.filter(node => node.kind === "button" && node.label === "More");
      if (more.length !== 1) throw new Error("Cannot identify Safari More before ordinary tab-group setup");
      nodes = await snapshot([press(more[0]!), { command: "press", input: { target: { kind: "selector", selector: 'label="All Tabs"' }, settle: true } }]);
    }
    return nodes;
  }
  async function ordinary(nodes: Nodes): Promise<Nodes> {
    const hasButtons = nodes.some(node => node.kind === "button" && node.identifier === "CapsuleTabGroup");
    const ordinary = hasButtons ? ordinaryGroup(nodes) : textTarget(nodes);
    if (!hasButtons || ordinary.selected !== true) {
      nodes = await snapshot([press(ordinary)]);
      const selected = ordinaryGroup(nodes);
      const expectedLabel = hasButtons ? ordinary.label : ordinary.label + ", Tab Group";
      if (selected.selected !== true || selected.label !== expectedLabel) throw new Error("Ordinary Safari tab group selection is unproved before navigation");
    }
    return nodes;
  }
  async function finish(nodes: Nodes): Promise<void> {
    const done = nodes.filter(node => node.kind === "button" && node.identifier === "DoneButton" && node.label === "Done");
    if (done.length !== 1) throw new Error("Cannot identify Safari Done before owned navigation");
    const page = await snapshot([press(done[0]!)]);
    const overview = page.some(node => typeof node.identifier === "string" &&
      (node.identifier === "TabOverview" || node.identifier === "CapsuleTabGroup" || node.identifier.startsWith("TabOverviewItemView?")));
    if (overview) throw new Error("Safari tab overview exit is unproved before navigation");
  }
  async function privateGroup(nodes: Nodes): Promise<Nodes> {
    const groups = nodes.filter(node => node.kind === "button" && node.identifier === "CapsuleTabGroup" && node.label === "Private, Tab Group");
    if (groups.length !== 1) throw new Error("Cannot identify one Private Safari tab group for owned cleanup");
    return snapshot([press(groups[0]!)]);
  }
  return { overview, ordinary, finish, privateGroup, snapshot };
}

export async function prepareIphoneSafari(command: NativeCommand, admission: Admission): Promise<void> {
  const safari = iphoneSafari(command, admission);
  await safari.finish(await safari.ordinary(await safari.overview()));
}
