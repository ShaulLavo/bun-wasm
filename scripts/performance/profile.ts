import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { array, number, object, sha256 } from "./input";

interface Node {
  id: number;
  name: string;
  url: string;
  children: number[];
  hits: number;
}

function parseProfile(input: unknown) {
  const saved = object(input);
  const value = "result" in saved ? object(object(saved.result).profile) : saved;
  const nodes = array(value.nodes).map(item => {
    const node = object(item), frame = object(node.callFrame);
    return { id: number(node.id), name: typeof frame.functionName === "string" ? frame.functionName : "", url: typeof frame.url === "string" ? frame.url : "",
      children: node.children === undefined ? [] : array(node.children).map(number), hits: 0 };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!nodes.length || byId.size !== nodes.length) throw new Error("empty or duplicate profile nodes");
  const parent = new Map<number, number>();
  for (const node of nodes) {
    for (const child of node.children) addParent(byId, parent, node.id, child);
  }
  const roots = nodes.filter(node => !parent.has(node.id));
  if (roots.length !== 1) throw new Error("profile must have one tree root");
  const ordered: Node[] = [], queue = [roots[0]!];
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!;
    if (ordered.length >= nodes.length) throw new Error("cyclic profile");
    ordered.push(node);
    queue.push(...node.children.map(id => byId.get(id)!));
  }
  if (ordered.length !== nodes.length) throw new Error("unreachable/cyclic profile nodes");
  const samples = array(value.samples).map(number);
  if (!samples.length) throw new Error("missing/empty sampled worker capture is not zero-cost evidence");
  for (const id of samples) {
    const node = byId.get(id);
    if (!node) throw new Error(`unknown sample node ${id}`);
    node.hits++;
  }
  const start = number(value.startTime), end = number(value.endTime);
  if (end <= start) throw new Error("invalid profile time bounds");
  return { ordered, byId, samples: samples.length, seconds: (end - start) / 1e6 };
}

function addParent(byId: ReadonlyMap<number, Node>, parent: Map<number, number>, caller: number, child: number) {
  if (!byId.has(child) || parent.has(child)) throw new Error("unknown child or multiple profile parents");
  parent.set(child, caller);
}

function wasm(node: Node) { return node.url.startsWith("wasm://") && !wrapper(node); }
function wrapper(node: Node) { return /^(wasm-to-js|js-to-wasm)/.test(node.name); }
function synthetic(node: Node) { return /^\((root|program|idle|garbage collector)\)$/.test(node.name); }
function key(node: Node) { return `${node.url} ${node.name || "(anonymous)"}`; }

export function splitProfile(input: unknown, context?: { configuration: string; scope: string }) {
  const profile = parseProfile(input);
  const totals = new Map<number, number>();
  const hasWasm = new Set<number>();
  for (const node of profile.ordered.toReversed()) {
    totals.set(node.id, node.hits + node.children.reduce((sum, id) => sum + totals.get(id)!, 0));
    if (wasm(node) || node.children.some(id => hasWasm.has(id))) hasWasm.add(node.id);
  }
  const detours: { caller: string; reentries: { callee: string; samples: number }[]; inclusiveSamples: number; overheadSamples: number }[] = [];
  const hostCalls: { caller: string; inclusiveSamples: number }[] = [];
  const detourNodes = new Set<number>(), overheadNodes = new Set<number>(), hostNodes = new Set<number>();
  for (const caller of profile.ordered.filter(wasm)) {
    for (const id of caller.children) crossing(caller, profile.byId.get(id)!);
  }
  function markSubtree(root: Node, target: Set<number>) {
    const queue = [root];
    for (let index = 0; index < queue.length; index++) {
      const node = queue[index]!;
      target.add(node.id);
      queue.push(...node.children.map(id => profile.byId.get(id)!));
    }
  }
  function visitBoundary(node: Node, queue: Node[], found: { callee: string; samples: number }[]) {
    if (wasm(node)) { found.push({ callee: key(node), samples: totals.get(node.id)! }); return 0; }
    overheadNodes.add(node.id);
    queue.push(...node.children.map(id => profile.byId.get(id)!));
    return node.hits;
  }
  function crossing(caller: Node, root: Node) {
    if (wasm(root) || synthetic(root)) return;
    if (!hasWasm.has(root.id)) {
      markSubtree(root, hostNodes);
      hostCalls.push({ caller: key(caller), inclusiveSamples: totals.get(root.id)! });
      return;
    }
    const reentries: { callee: string; samples: number }[] = [];
    const queue = [root];
    let overheadSamples = 0;
    for (let index = 0; index < queue.length; index++) overheadSamples += visitBoundary(queue[index]!, queue, reentries);
    markSubtree(root, detourNodes);
    detours.push({ caller: key(caller), reentries, inclusiveSamples: totals.get(root.id)!, overheadSamples });
  }
  const unionHits = (ids: ReadonlySet<number>) => Array.from(ids).reduce((sum, id) => sum + profile.byId.get(id)!.hits, 0);
  const percent = (hits: number) => 100 * hits / profile.samples;
  const self = profile.ordered.filter(node => node.hits > 0).map(node => ({ frame: key(node), samples: node.hits, kind: selfKind(node) }));
  self.sort((left, right) => right.samples - left.samples);
  return { configuration: context?.configuration ?? "sm-chrome-wasm32-interp", scope: context?.scope ?? "one saved sampled worker; not complete Chrome CPU or lifecycle time",
    sampleDefinition: "each entry in profile.samples has equal weight; node.hitCount and elapsed thread CPU are not denominators",
    boundaryDefinition: "structural Wasm to JavaScript subtree with a Wasm reentry; inclusive includes useful callee work; overhead is self samples before first reentry",
    overlap: "nested crossing rows overlap; totals use node unions; host work can lie inside useful detour work",
    samples: profile.samples, seconds: profile.seconds,
    sampleKinds: { included: "all supplied sample entries, including idle, program, GC and unresolved leaves", excluded: "unsampled native/helper CPU, lost workers and work outside the supplied capture", weighting: "equal sample entries, not timeDeltas" },
    self, unknownSelfSamples: self.filter(row => row.kind === "unknown").reduce((sum, row) => sum + row.samples, 0),
    strippedWasmSelfSamples: profile.ordered.filter(node => wasm(node) && (!node.name || /^(?:wasm-function\[\d+\]|\d+)$/.test(node.name))).reduce((sum, node) => sum + node.hits, 0),
    wasmSelfSamples: profile.ordered.filter(wasm).reduce((sum, node) => sum + node.hits, 0),
    wrapperSelfSamples: profile.ordered.filter(wrapper).reduce((sum, node) => sum + node.hits, 0),
    detourInclusivePercent: percent(unionHits(detourNodes)), detourOverheadPercent: percent(unionHits(overheadNodes)),
    hostInclusivePercent: percent(unionHits(hostNodes)), detours, hostCalls };
}

function selfKind(node: Node): string {
  if (wrapper(node)) return "boundary-wrapper";
  if (/^\((root|program|idle)\)$/.test(node.name)) return "synthetic";
  if (/\/fs-worker\.js(?:[?#]|$)/.test(node.url)) return "waffle-filesystem";
  if (/\/(?:shell|notification)-worker\.js(?:[?#]|$)/.test(node.url)) return "waffle-process-host";
  if (node.name === "(garbage collector)" || /(?:^|::)(?:GCRuntime::|gc_collect|JS_RunGC|collectGarbage)/.test(node.name)) return "gc";
  if (wasm(node) && /(?:js::Interpret|JS_CallInternal|JS_Execute|JSC::LLInt|llint_entry|llint_slow_path)/.test(node.name)) return "engine-interpreter";
  if (wasm(node) && /(?:bunwasm|bun_core_|Bun__)/.test(node.name)) return "bun-runtime";
  return "unknown";
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: profile.ts SAVED_CHROME_PROFILE.json NEW_OUTPUT.json");
  const bytes = readFileSync(resolve(input));
  const result = splitProfile(JSON.parse(bytes.toString()));
  writeFileSync(resolve(output), JSON.stringify({ input: resolve(input), inputSha256: sha256(bytes), ...result }, null, 2) + "\n", { flag: "wx" });
}
