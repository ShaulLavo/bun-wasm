import { array, number, object, string } from "./input";
import { splitProfile } from "./profile";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

type JsonObject = Record<string, unknown>;
interface TraceGroup { pid: number; tid: number; id: string; start: number; end: number | null; nodes: JsonObject[]; samples: number[]; deltas: number[] }
export function chromeProfiles(input: unknown) {
  const events = array(object(input).traceEvents).map(object);
  const groups = new Map<string, TraceGroup>();
  for (const event of events.filter(row => row.name === "Profile" || row.name === "ProfileChunk")) addChunk(groups, event);
  const workers = events.filter(event => event.name === "TimeStamp").flatMap(event => {
    const data = object(object(event.args).data);
    return typeof data.message === "string" && data.message.startsWith("lifecycle-profile-target:")
      ? [{ workerId: data.message.slice("lifecycle-profile-target:".length), workerThreadId: number(event.tid), pid: number(event.pid) }] : [];
  });
  return Array.from(groups.values()).filter(group => group.samples.length > 0).map(group => {
    const worker = workers.find(row => row.workerThreadId === group.tid && row.pid === group.pid);
    const children = new Map<number, number[]>();
    for (const node of group.nodes) {
      if (node.parent === undefined) continue;
      const id = number(node.parent), siblings = children.get(id) ?? [];
      siblings.push(number(node.id)); children.set(id, siblings);
    }
    const nodes = group.nodes.map(node => ({ ...node, children: children.get(number(node.id)) ?? [] }));
    return { pid: group.pid, tid: group.tid, id: group.id, worker: worker ?? null,
      profile: { nodes, samples: group.samples, startTime: group.start, endTime: group.end ?? group.start + group.deltas.reduce((sum, delta) => sum + delta, 0) } };
  });
}
function addChunk(groups: Map<string, TraceGroup>, event: JsonObject) {
  const pid = number(event.pid), tid = number(event.tid), id = String(event.id);
  const key = `${pid}:${id}`;
  const data = object(object(event.args).data);
  const group = groups.get(key) ?? { pid, tid, id, start: number(data.startTime), end: null, nodes: [], samples: [], deltas: [] };
  groups.set(key, group);
  if (event.name === "Profile") return;
  if (data.endTime !== undefined) { group.end = number(data.endTime); return; }
  const profile = object(data.cpuProfile);
  group.nodes.push(...array(profile.nodes ?? []).map(object));
  group.samples.push(...array(profile.samples ?? []).map(number));
  group.deltas.push(...array(data.timeDeltas ?? []).map(value => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid trace time delta");
    return value;
  }));
  if (group.samples.length !== group.deltas.length) throw new Error("Trace sample/delta coverage differs");
}

export function analyzeChrome(input: unknown, configuration: string, phase: string) {
  return chromeProfiles(input).map(row => ({ ...row, profile: undefined,
    analysis: splitProfile(row.profile, { configuration, scope: `${phase}; trace pid ${row.pid}, tid ${row.tid}, profile ${row.id}; worker identity requires metadata` }) }));
}

export function chromeControl(input: unknown, targetsInput: unknown, engine: string, window: { before: number; after: number }) {
  const targets = array(targetsInput).map(object);
  const rows = analyzeChrome(input, engine, "root/child control").filter(row => row.worker !== null);
  const evidence = rows.map(row => {
    const id = row.worker?.workerId;
    const birth = targets.find(target => target.id === id && target.event === "born" && target.type === "worker");
    const exit = targets.find(target => target.id === id && target.event === "exited");
    const inWindow = birth && exit && number(birth.at) >= window.before && number(exit.at) <= window.after;
    const compute = engine === "browser" ? row.analysis.self.some(frame => /lifecycleProfile(Root|Child)/.test(frame.frame))
      : row.analysis.self.some(frame => frame.kind === "engine-interpreter");
    return { tid: row.tid, worker: row.worker, birth: birth ?? null, exit: exit ?? null, inWindow: Boolean(inWindow), compute,
      childComputation: row.analysis.self.some(frame => /lifecycleProfileChild/.test(frame.frame)), samples: row.analysis.samples };
  });
  const classified = evidence.filter(row => row.inWindow && row.compute);
  return { available: new Set(classified.map(row => row.worker?.workerId)).size >= 2 && (engine !== "browser" || classified.some(row => row.childComputation)), evidence,
    rule: "At least two distinct worker profiles with engine computation samples and workerId-matched birth and exit inside capture; browser-engine names or named interpreter frames required" };
}

function geckoThreads(input: unknown, inheritedStart?: number): { thread: JsonObject; start: number }[] {
  const profile = object(input);
  const meta = object(profile.meta);
  const start = typeof meta.startTime === "number" ? meta.startTime : inheritedStart;
  if (start === undefined) throw new Error("Gecko process time origin unavailable");
  return array(profile.threads).map(thread => ({ thread: object(thread), start }))
    .concat(...array(profile.processes ?? []).map(child => geckoThreads(child, start)));
}
function table(value: unknown) { const row = object(value); return { schema: object(row.schema), data: array(row.data).map(array) }; }
function frameString(value: unknown): string { if (typeof value !== "string") throw new Error("Invalid Gecko frame string"); return value; }
function geckoStack(tables: { stacks: ReturnType<typeof table>; frames: ReturnType<typeof table>; strings: string[] }, index: unknown): string[] {
  const { stacks, frames, strings } = tables;
  const labels: string[] = [];
  const seen = new Set<number>();
  while (index !== null && index !== undefined) {
    const id = number(index);
    if (seen.has(id)) throw new Error("Cyclic Gecko stack");
    seen.add(id);
    const row = stacks.data[id];
    if (!row) throw new Error("Missing Gecko stack");
    const frame = frames.data[number(row[number(stacks.schema.frame)])];
    labels.push(frame ? strings[number(frame[number(frames.schema.location)])] ?? "(unknown)" : "(unknown)");
    index = row[number(stacks.schema.prefix)];
  }
  return labels.toReversed();
}
export function analyzeGecko(input: unknown, window: { before: number; after: number }) {
  return geckoThreads(input).filter(({ thread }) => string(thread.name).includes("DOM Worker")).map(({ thread, start }) => {
    const samples = table(thread.samples);
    const tables = { stacks: table(thread.stackTable), frames: table(thread.frameTable), strings: array(thread.stringTable).map(frameString) };
    const selected = samples.data.filter(row => { const time = start + number(row[number(samples.schema.time)]); return time >= window.before && time <= window.after; });
    const observedTimes = selected.map(row => start + number(row[number(samples.schema.time)]));
    const expectedStart = typeof thread.registerTime === "number" ? Math.max(window.before, start + thread.registerTime) : window.before;
    const stacks = selected.map(row => geckoStack(tables, row[number(samples.schema.stack)]));
    const names = new Map<string, number>();
    const named = new Map<string, number>();
    for (const stack of stacks) { const leaf = stack.at(-1) ?? "(no stack)"; names.set(leaf, (names.get(leaf) ?? 0) + 1); }
    for (const stack of stacks) { const leaf = stack.findLast(frame => !frame.startsWith("0x")) ?? "(no named frame)"; named.set(leaf, (named.get(leaf) ?? 0) + 1); }
    return { name: thread.name, pid: thread.pid, tid: thread.tid, registerTime: thread.registerTime, unregisterTime: thread.unregisterTime,
      start, samples: selected.length, notNamedWaitSamples: stacks.filter(stack => !stack.some(frame => frame.includes("WorkerPrivate::WaitForWorkerEvents"))).length,
      observedWindowEpochMs: { first: observedTimes[0] ?? null, last: observedTimes.at(-1) ?? null },
      retention: { expectedStartEpochMs: expectedStart, firstSampleLagMs: observedTimes[0] === undefined ? null : observedTimes[0] - expectedStart,
        coverage: "Observed endpoints only; shutdown buffers can lose early samples and sampling does not prove coverage between endpoints" },
      waitCoverage: "Only symbolically named waits excluded; unresolved native addresses may include waits. This is not CPU time or a busy-sample denominator",
      scriptLabels: tables.strings.filter(frame => frame.startsWith("WorkerThreadPrimaryRunnable::Run")),
      rootComputation: stacks.filter(stack => stack.some(frame => /lifecycleProfileRoot/.test(frame))).length,
      childComputation: stacks.filter(stack => stack.some(frame => /lifecycleProfileChild/.test(frame))).length,
      interpreterSamples: stacks.filter(stack => stack.some(frame => /js::Interpret|JS_CallBytecode|JS_CallInternal|JS_Execute|JSC::LLInt|llint_entry/.test(frame))).length,
      gcNamedSamples: stacks.filter(stack => stack.some(frame => /js::gc::|GCRuntime::|GC::collect|collectGarbage/.test(frame))).length,
      unknownLeafSamples: stacks.filter(stack => !stack.length || /^(?:0x|\(unknown\))/.test(stack.at(-1)!)).length,
      strippedWasmSamples: stacks.filter(stack => stack.some(frame => /wasm-function\[\d+\]/.test(frame))).length,
      self: Array.from(names, ([frame, count]) => ({ frame, samples: count })).sort((a, b) => b.samples - a.samples),
      innermostNamed: Array.from(named, ([frame, count]) => ({ frame, samples: count })).sort((a, b) => b.samples - a.samples),
      sampleKinds: { included: "All DOM Worker samples within epoch-aligned command observation window, including idle, empty and native addresses", excluded: "Other thread roles and samples outside window; unsymbolicated addresses stay unknown" },
      boundaryAnalysis: null, boundaryReason: "Raw Gecko mixed native/JS/Wasm stacks have no validated equivalent to Chrome structural Wasm URL boundaries" };
  });
}
export function geckoControl(input: unknown, window: { before: number; after: number }, engine: string) {
  const rows = analyzeGecko(input, window);
  const evidence = rows.filter(row => typeof row.registerTime === "number" && typeof row.unregisterTime === "number")
    .map(row => ({ ...row, inWindow: row.start + number(row.registerTime) >= window.before && row.start + number(row.unregisterTime) <= window.after }));
  const classified = evidence.filter(row => row.inWindow && (engine === "browser" ? row.rootComputation > 0 : row.interpreterSamples > 0));
  return { available: classified.length >= 2 && (engine !== "browser" || classified.some(row => row.childComputation > 0)), evidence,
    rule: "Two computation-bearing DOM workers registered and unregistered within command window, retained in shutdown profile; named interpreter frames required for in-Wasm engines" };
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: lifecycle-profile-analysis.ts CAPTURE_DIRECTORY; writes reanalysis.json without replacing original records");
  const run = object(JSON.parse(await readFile(join(directory, "run.json"), "utf8")));
  const configuration = object(run.configuration);
  const windowInput = object(run.window), window = { before: number(windowInput.before), after: number(windowInput.after) };
  const browser = string(configuration.browser), engine = string(configuration.engine), phase = string(configuration.phase);
  const path = join(directory, browser === "chrome" ? "chrome-trace.json" : "gecko.json");
  const bytes = await readFile(path).catch(async () => gunzipSync(await readFile(path + ".gz")));
  const input = JSON.parse(bytes.toString());
  const rows = browser === "chrome" ? analyzeChrome(input, engine, phase) : analyzeGecko(input, window);
  const control = phase === "control" ? (browser === "chrome" ? chromeControl(input, JSON.parse(await readFile(join(directory, "chrome-targets.json"), "utf8")), engine, window) : geckoControl(input, window, engine)) : null;
  await writeFile(join(directory, "reanalysis.json"), JSON.stringify({ ...run, reanalysisOf: "run.json", observation: { enabled: true, profile: control ?? { available: true } }, rows }, null, 2) + "\n", { flag: "wx" });
}
