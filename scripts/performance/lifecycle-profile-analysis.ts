import { array, number, object, string } from "./input";
import { splitProfile } from "./profile";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromeRetention } from "./lifecycle-profile-retention";

type JsonObject = Record<string, unknown>;
interface TraceGroup { pid: number; tid: number; id: string; start: number; end: number | null; nodes: JsonObject[]; samples: number[]; deltas: number[] }
export interface ChromeWindowMarkers { begin: string; end: string }
type EpochWindow = { before: number; after: number };
export type ChromeContext = { kind: "capture"; reason: string } | { kind: "command"; markers: ChromeWindowMarkers; window: EpochWindow; targets: unknown; telemetry: unknown };
const widerCapture: ChromeContext = { kind: "capture", reason: "No recorded trace-clock command boundaries; controller epoch timestamps cannot be joined by guessing an offset" };
export function chromeContext(markers: unknown, window: EpochWindow, targets: unknown, telemetry?: unknown): ChromeContext {
  if (markers === null || markers === undefined) return widerCapture;
  const value = object(markers);
  return { kind: "command", markers: { begin: string(value.begin), end: string(value.end) }, window, targets, telemetry };
}
function traceWindow(events: JsonObject[], context: ChromeContext, retention: ReturnType<typeof chromeRetention>) {
  if (context.kind === "capture") return { available: false as const, reason: context.reason };
  if (!retention.available) return { available: false as const, reason: retention.reasons.join("; ") };
  const begin = timestampEvents(events, context.markers.begin), end = timestampEvents(events, context.markers.end);
  if (begin.length !== 1 || end.length !== 1 || number(begin[0]!.ts) >= number(end[0]!.ts)) {
    return { available: false as const, reason: "Missing, ambiguous or reversed trace-clock command markers" };
  }
  return { available: true as const, beforeUs: number(begin[0]!.ts), afterUs: number(end[0]!.ts),
    clock: "Chrome trace event ts, microseconds", source: context.markers, epochOffset: null };
}
function timestampEvents(events: JsonObject[], message: string) {
  return events.filter(event => markerName(event) === message);
}
function markerName(event: JsonObject) {
  if (typeof event.cat === "string" && event.cat.split(",").includes("blink.user_timing") && (event.ph === "I" || event.ph === "R")) return event.name;
  if (event.name === "TimeStamp") return object(object(event.args).data).message;
  return null;
}
function workerMarkers(events: JsonObject[]) {
  return events.flatMap(event => {
    const name = markerName(event);
    return typeof name === "string" && name.startsWith("lifecycle-profile-target:")
      ? [{ workerId: name.slice("lifecycle-profile-target:".length), workerThreadId: number(event.tid), pid: number(event.pid), markerUs: number(event.ts) }] : [];
  });
}
function matchWorker(group: TraceGroup, end: number, markers: ReturnType<typeof workerMarkers>, context: ChromeContext, aligned: boolean) {
  const candidates = markers.filter(row => row.workerThreadId === group.tid && row.pid === group.pid && row.markerUs >= group.start && row.markerUs <= end);
  if (!aligned || context.kind !== "command") return { worker: null, reason: "Worker lifetime cannot be joined to an established command window" };
  if (candidates.length !== 1) return { worker: null, reason: "Profile has missing or multiple temporal worker markers; reused/ambiguous lifetime remains unmapped" };
  const marker = candidates[0]!;
  const targets = array(context.targets).map(object);
  const births = targets.filter(target => target.id === marker.workerId && target.event === "born" && target.type === "worker");
  const exits = targets.filter(target => target.id === marker.workerId && target.event === "exited");
  if (births.length !== 1 || exits.length !== 1) return { worker: null, reason: "Unique target birth and exit evidence unavailable" };
  const birthEpochMs = number(births[0]!.at), exitEpochMs = number(exits[0]!.at);
  if (exitEpochMs <= birthEpochMs || birthEpochMs > context.window.after || exitEpochMs < context.window.before) return { worker: null, reason: "Target lifetime contradicts or does not overlap the controller command window" };
  return { worker: { ...marker, birthEpochMs, exitEpochMs, profileStartUs: group.start, profileEndUs: end },
    reason: "Unique marker inside this profile lifetime; samples before its identity marker are excluded. Epoch lifetime and trace bounds retain separate clocks" };
}
export function chromeProfiles(input: unknown, context: ChromeContext = widerCapture) {
  const events = array(object(input).traceEvents).map(object);
  const groups = new Map<string, TraceGroup>();
  for (const event of events.filter(row => row.name === "Profile" || row.name === "ProfileChunk")) addChunk(groups, event);
  const retention = chromeRetention(input, context.kind === "command" ? context.telemetry : undefined);
  const markers = workerMarkers(events), workloadWindow = traceWindow(events, context, retention);
  const sampled = Array.from(groups.values()).filter(group => group.samples.length > 0);
  if (!sampled.length) throw new Error("Missing/empty sampled trace is not zero-cost evidence");
  return sampled.map(group => ({ ...scopedChrome(group, markers, context, workloadWindow), retention }));
}
function scopedChrome(group: TraceGroup, markers: ReturnType<typeof workerMarkers>, context: ChromeContext, workloadWindow: ReturnType<typeof traceWindow>) {
  const children = new Map<number, number[]>();
  for (const node of group.nodes) {
    if (node.parent === undefined) continue;
    const id = number(node.parent), siblings = children.get(id) ?? [];
    siblings.push(number(node.id)); children.set(id, siblings);
  }
  const nodes = group.nodes.map(node => ({ ...node, children: children.get(number(node.id)) ?? [] }));
  const end = group.end ?? group.start + group.deltas.reduce((sum, delta) => sum + delta, 0);
  const identity = matchWorker(group, end, markers, context, workloadWindow.available);
  const before = workloadWindow.available ? Math.max(group.start, workloadWindow.beforeUs, identity.worker?.markerUs ?? 0) : group.start;
  const after = workloadWindow.available ? Math.min(end, workloadWindow.afterUs) : end;
  const samples: number[] = [], sampleTimesUs: number[] = [];
  let time = group.start;
  for (let index = 0; index < group.samples.length; index++) {
    time += group.deltas[index]!;
    if (!Number.isFinite(time)) throw new Error("Invalid cumulative Chrome sample timestamp");
    if (workloadWindow.available && (time < before || time > after)) continue;
    samples.push(group.samples[index]!); sampleTimesUs.push(time);
  }
  return { pid: group.pid, tid: group.tid, id: group.id, worker: identity.worker, workerMapping: identity.reason, workloadWindow,
    selection: { captureSamples: group.samples.length, includedSamples: samples.length, excludedSamples: group.samples.length - samples.length,
      method: "Cumulative startTime plus signed timeDeltas; equal entry weighting. Identity-bound samples exclude the prefix before their worker marker" },
    sampleTimesUs, profile: { nodes, samples, startTime: before, endTime: after } };
}
function addChunk(groups: Map<string, TraceGroup>, event: JsonObject) {
  const pid = number(event.pid), tid = number(event.tid), id = String(event.id);
  const key = `${pid}:${id}`;
  const data = object(object(event.args).data);
  if (event.name === "Profile") {
    if (groups.has(key)) throw new Error("Duplicate profile start");
    groups.set(key, { pid, tid, id, start: number(data.startTime), end: null, nodes: [], samples: [], deltas: [] });
    return;
  }
  if (data.cpuProfile === undefined && data.endTime === undefined && data.source === "Internal") {
    if (Object.keys(data).length !== 1 || event.ph !== "P" || typeof event.id !== "string" || !event.id ||
      typeof event.cat !== "string" || !event.cat.split(",").includes("disabled-by-default-v8.cpu_profiler")) throw new Error("Malformed source-only ProfileChunk");
    number(event.ts); number(event.tts);
    return;
  }
  const group = groups.get(key);
  if (!group) throw new Error("Missing profile start");
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

export function analyzeChrome(input: unknown, configuration: string, phase: string, context: ChromeContext = widerCapture) {
  return chromeProfiles(input, context).filter(row => row.profile.samples.length > 0).map(row => ({ ...row, profile: undefined, sampleTimesUs: undefined,
    sampleClock: "Chrome trace microseconds; per-entry timestamps remain reconstructible from the compressed raw chunks, never epoch-offset inferred",
    analysis: splitProfile(row.profile, { configuration, scope: `${row.workloadWindow.available ? "trace-clock command marker window" : "wider capture; exact workload attribution unavailable"}; requested phase ${phase}; pid ${row.pid}, tid ${row.tid}, profile ${row.id}` }) }));
}

export function chromeControl(input: unknown, targetsInput: unknown, engine: string, window: EpochWindow, markers: ChromeWindowMarkers | null = null, telemetry?: unknown) {
  const targets = array(targetsInput).map(object);
  const context = chromeContext(markers, window, targetsInput, telemetry);
  const retention = chromeRetention(input, telemetry);
  const aligned = traceWindow(array(object(input).traceEvents).map(object), context, retention);
  const rows = analyzeChrome(input, engine, "root/child control", context).filter(row => row.worker !== null);
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
  return { available: aligned.available && new Set(classified.map(row => row.worker?.workerId)).size >= 2 && (engine !== "browser" || classified.some(row => row.childComputation)), workloadWindow: aligned, retention, evidence,
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
  const threads = geckoThreads(input).filter(({ thread }) => string(thread.name).includes("DOM Worker"));
  const identities = new Set<string>();
  for (const { thread, start } of threads) validateGeckoIdentity(thread, start, identities);
  return threads.map(({ thread, start }) => {
    const samples = table(thread.samples);
    const tables = { stacks: table(thread.stackTable), frames: table(thread.frameTable), strings: array(thread.stringTable).map(frameString) };
    const lifetimeStart = typeof thread.registerTime === "number" ? start + number(thread.registerTime) : null;
    const lifetimeEnd = typeof thread.unregisterTime === "number" ? start + number(thread.unregisterTime) : null;
    const selected = samples.data.filter(row => { const time = start + number(row[number(samples.schema.time)]); return time >= Math.max(window.before, lifetimeStart ?? window.before) && time <= Math.min(window.after, lifetimeEnd ?? window.after); });
    const observedTimes = selected.map(row => start + number(row[number(samples.schema.time)]));
    const expectedStart = typeof thread.registerTime === "number" ? Math.max(window.before, start + thread.registerTime) : window.before;
    const stacks = selected.map(row => geckoStack(tables, row[number(samples.schema.stack)]));
    const names = new Map<string, number>();
    const named = new Map<string, number>();
    for (const stack of stacks) { const leaf = stack.at(-1) ?? "(no stack)"; names.set(leaf, (names.get(leaf) ?? 0) + 1); }
    for (const stack of stacks) { const leaf = stack.findLast(frame => !frame.startsWith("0x")) ?? "(no named frame)"; named.set(leaf, (named.get(leaf) ?? 0) + 1); }
    return { name: thread.name, pid: thread.pid, tid: thread.tid, registerTime: thread.registerTime, unregisterTime: thread.unregisterTime,
      identity: `${start}:${thread.pid}:${thread.tid}:${thread.registerTime}`, lifetimeEpochMs: { before: lifetimeStart, after: lifetimeEnd },
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
      sampleKinds: { included: "All DOM Worker samples in the epoch-aligned command/known-lifetime intersection, including idle, empty and native addresses", excluded: "Other thread roles and samples outside window or known lifetime; unsymbolicated addresses and missing lifetime endpoints stay unknown" },
      boundaryAnalysis: null, boundaryReason: "Raw Gecko mixed native/JS/Wasm stacks have no validated equivalent to Chrome structural Wasm URL boundaries" };
  });
}
function validateGeckoIdentity(thread: JsonObject, start: number, identities: Set<string>) {
  if (thread.registerTime === null || thread.registerTime === undefined) return;
  const birth = number(thread.registerTime);
  if (thread.unregisterTime !== null && thread.unregisterTime !== undefined && number(thread.unregisterTime) < birth) throw new Error("Contradictory Gecko worker lifetime");
  if ((typeof thread.pid !== "number" && typeof thread.pid !== "string") || (typeof thread.tid !== "number" && typeof thread.tid !== "string")) throw new Error("Missing Gecko worker identity");
  const identity = `${start}:${thread.pid}:${thread.tid}:${birth}`;
  if (identities.has(identity)) throw new Error("Duplicate or conflicting Gecko worker identity");
  identities.add(identity);
}
export function geckoControl(input: unknown, window: { before: number; after: number }, engine: string) {
  const rows = analyzeGecko(input, window);
  const evidence = rows.filter(row => typeof row.registerTime === "number" && typeof row.unregisterTime === "number")
    .map(row => ({ ...row, inWindow: row.start + number(row.registerTime) >= window.before && row.start + number(row.unregisterTime) <= window.after }));
  const classified = evidence.filter(row => row.inWindow && (engine === "browser" ? row.rootComputation > 0 : row.interpreterSamples > 0));
  return { available: new Set(classified.map(row => row.identity)).size >= 2 && (engine !== "browser" || classified.some(row => row.childComputation > 0)), evidence,
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
  const targets = browser === "chrome" ? JSON.parse(await readFile(join(directory, "chrome-targets.json"), "utf8")) : null;
  const telemetry = browser === "chrome" ? await readFile(join(directory, "chrome-retention.json"), "utf8").then(JSON.parse).catch(() => null) : null;
  const context = chromeContext(run.chromeWindowMarkers, window, targets, telemetry);
  const rows = browser === "chrome" ? analyzeChrome(input, engine, phase, context) : analyzeGecko(input, window);
  const control = phase === "control" ? (browser === "chrome" ? chromeControl(input, targets, engine, window, context.kind === "command" ? context.markers : null, telemetry) : geckoControl(input, window, engine)) : null;
  const available = browser !== "chrome" || rows.some(row => "workloadWindow" in row && row.workloadWindow.available && row.worker !== null);
  await writeFile(join(directory, "reanalysis.json"), JSON.stringify({ ...run, reanalysisOf: "run.json", observation: { enabled: true, profile: control ?? {
    available, captureAvailable: rows.length > 0, scope: available ? "Established command/lifetime sample subset" : "Wider capture only; workload clock/lifetime join unavailable" } }, rows }, null, 2) + "\n", { flag: "wx" });
}
