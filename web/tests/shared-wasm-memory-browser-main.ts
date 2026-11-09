// Real shared-group guest on the production Browser host: startRun, Waffle's broker and worker.
import { createRuntime } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { prepareProgram } from "../../src/assets.ts";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { startRun } from "../src/runner";

const FIXTURE = "/home/user/fixture";
const CONTROL = "/home/user/control";

const MEMBER_TAG = "--shared-wasm-member=";

type MemoryGroupSnapshot = ReturnType<BrowserProcessBroker["memoryGroups"]>[number];
interface GroupOwners {
  readonly budget: { readonly committed: number };
  readonly groups: Map<string, { snapshot(): MemoryGroupSnapshot }>;
}
type BrokerChild = { readonly context?: { readonly request?: { readonly argv?: readonly string[] } } };
interface MemberWatch { sample(): void; settled(): Promise<void>; ended(): readonly MemoryGroupSnapshot[]; budget(): number; }

/** runtime.processes() is a capability facade. This keeps the real broker for test inspection. */
function captureBroker(): () => BrowserProcessBroker | undefined {
  let broker: BrowserProcessBroker | undefined;
  const remember = (instance: BrowserProcessBroker) => { broker = instance; };
  const memoryGroups = BrowserProcessBroker.prototype.memoryGroups;
  BrowserProcessBroker.prototype.memoryGroups = function (this: BrowserProcessBroker) {
    remember(this);
    return memoryGroups.call(this);
  };
  return () => broker;
}

/**
 * Publishes the owner's view for fixtures (page-control.ts) and keeps every owner so a group that
 * has already ended can still be inspected. Reaches broker internals deliberately: test-only.
 */
function watchMembers(runtime: ReturnType<typeof createRuntime>, processes: Awaited<ReturnType<ReturnType<typeof createRuntime>["processes"]>>, broker: () => BrowserProcessBroker | undefined): MemberWatch {
  const owners = new Map<string, { snapshot(): MemoryGroupSnapshot }>();
  const tags = new Map<number, string>();
  const gone = new Set<number>();
  const encoder = new TextEncoder();
  // The broker creates its group table at the first admission.
  const groups = () => Reflect.get(broker() ?? {}, "groups") as GroupOwners | undefined;
  const children = () => Reflect.get(broker() ?? {}, "children") as Map<number, BrokerChild> | undefined;
  const tagOf = (pid: number) => children()?.get(pid)?.context?.request?.argv?.find(value => value.startsWith(MEMBER_TAG))?.slice(MEMBER_TAG.length);
  let writes = Promise.resolve();
  const publish = (path: string, text: string) => {
    writes = writes.then(async () => {
      await runtime.filesystem.writeFile(path, encoder.encode(text));
      await runtime.filesystem.flush();
    });
  };
  const observeMember = (group: MemoryGroupSnapshot, pid: number) => {
    if (tags.has(pid)) return;
    const tag = tagOf(pid);
    if (tag === undefined) return;
    tags.set(pid, tag);
    publish(`${CONTROL}/group/${tag}`, group.id);
  };
  const observeGroup = (group: MemoryGroupSnapshot, live: Set<number>) => {
    const owner = groups()?.groups.get(group.id);
    if (owner) owners.set(group.id, owner);
    for (const pid of group.pids) {
      live.add(pid);
      observeMember(group, pid);
    }
  };
  return {
    sample() {
      const live = new Set<number>();
      for (const group of processes.memoryGroups()) observeGroup(group, live);
      for (const [pid, tag] of tags) {
        if (live.has(pid) || gone.has(pid)) continue;
        gone.add(pid);
        publish(`${CONTROL}/gone/${tag}`, "stopped");
      }
    },
    settled: () => writes,
    ended: () => Array.from(owners.values(), owner => owner.snapshot()),
    budget: () => groups()?.budget.committed ?? -1,
  };
}

async function bytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetch failed: ${url} ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function run() {
  if (!crossOriginIsolated) throw new Error("A memory group requires a cross-origin isolated page");
  const broker = captureBroker();
  const manifest: unknown = await (await fetch("./fixture/index.json")).json();
  if (!Array.isArray(manifest)) throw new Error("Invalid fixture manifest");
  const names = manifest.map(String);
  const entry = new URLSearchParams(location.search).get("entry") ?? "browser-guest.ts";
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) },
    memoryGroups: BUN_MEMORY_GROUP_POLICY,
  });
  await runtime.filesystem.mkdirp(FIXTURE);
  for (const name of names) await runtime.filesystem.writeFile(`${FIXTURE}/${name}`, await bytes(`./fixture/${name}`));
  await runtime.filesystem.mkdirp(`${CONTROL}/group`);
  await runtime.filesystem.mkdirp(`${CONTROL}/gone`);
  await runtime.filesystem.flush();
  const kind: unknown = await (await fetch("./program/kind.json")).json();
  if (kind !== "quickjs" && kind !== "jsc") throw new Error("Invalid program kind");
  const module = await prepareProgram({ kind, core: await bytes("./program/bun.wasm"), side: await bytes("./program/side.wasm") });
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const started = performance.now();
  const job = startRun({
    runtime, module, engine: kind, moduleScope: false,
    args: ["run", `${FIXTURE}/${entry}`],
    env: { PWD: FIXTURE, HOME: "/home/user", PATH: "/bin:/usr/bin", SHARED_WASM_PAGE_CONTROL: CONTROL },
  }, {
    stdout(data) { stdout += decoder.decode(data, { stream: true }); },
    stderr(data) { stderr += decoder.decode(data, { stream: true }); },
  });
  // Owner-side counters while members live: proof real regions were reserved and charged.
  const processes = await runtime.processes();
  const members = watchMembers(runtime, processes, broker);
  const peak = { groups: 0, regions: 0, holds: 0, committedBytes: 0 };
  const sampling = setInterval(() => {
    members.sample();
    const groups = processes.memoryGroups();
    peak.groups = Math.max(peak.groups, groups.length);
    peak.regions = Math.max(peak.regions, groups.reduce((sum, group) => sum + group.regions, 0));
    peak.holds = Math.max(peak.holds, groups.reduce((sum, group) => sum + group.holds, 0));
    peak.committedBytes = Math.max(peak.committedBytes, groups.reduce((sum, group) => sum + group.committedBytes, 0));
  }, 1);
  const result = await job.done;
  clearInterval(sampling);
  const wallMs = performance.now() - started;
  // The broker releases a member only after its physical stop, which trails run.done.
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && processes.memoryGroups().some(group => group.members > 0 || group.retained > 0)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  members.sample();
  await members.settled();
  return { ...result, wallMs, stdout, stderr, peak, groups: processes.memoryGroups(), ended: members.ended(), budget: members.budget() };
}

void run().then(
  value => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, ...value }),
  (error: unknown) => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, thrown: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }),
);
