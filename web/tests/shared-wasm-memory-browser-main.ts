// Real shared-group guest on the production Browser host: startRun, Waffle's broker and worker.
import { createRuntime } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { prepareProgram } from "../../src/assets.ts";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { startRun } from "../src/runner";

const FIXTURE = "/home/user/fixture";
const CONTROL = "/home/user/control";

const MEMBER_TAG = "--shared-wasm-member=";
const STALL_OPEN = "stall-open-";
const FAIL_STOP = "fail-stop-";
const GROUP_OPEN = 10;
const STALLED_OPEN = 2;
const DEBT_ENTRY = "failed-stop.ts";

type MemoryGroupSnapshot = ReturnType<BrowserProcessBroker["memoryGroups"]>[number];
type GroupMember = { readonly pid: number; readonly holds: Map<number, number> };
type GroupMessage = { readonly op: number; readonly args: readonly number[] };
interface GroupOwner {
  snapshot(): MemoryGroupSnapshot;
  answer(member: GroupMember, data: GroupMessage): void;
  dispatch(member: GroupMember, op: number, args: readonly number[]): number[];
}
interface GroupOwners {
  readonly budget: { readonly committed: number };
  readonly groups: Map<string, GroupOwner>;
}
type BrokerChild = { readonly worker?: Worker; readonly context?: { readonly request?: { readonly argv?: readonly string[] } } };
interface MemberWatch { sample(): void; settled(): Promise<void>; ended(): readonly MemoryGroupSnapshot[]; budget(): number; closeDelays(): Readonly<Record<string, number>>; }

/** Every production worker's lock name, and the fixture tag once the page has matched it to a member. */
const agents = new WeakMap<Worker, { readonly id: string; tag?: string }>();

/** Names each worker for its agent lock, and can refuse one member's native stop. */
function installAgentWorkers(): void {
  const NativeWorker = Worker;
  let next = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const id = `shared-wasm-agent-${next++}`;
      super(url, { ...options, name: id });
      agents.set(this, { id });
    }
    override terminate(): void {
      if (agents.get(this)?.tag?.startsWith(FAIL_STOP)) throw new Error("injected native terminate failure");
      super.terminate();
    }
  };
}

function ownerHolds(owner: GroupOwner | undefined, member?: GroupMember): string {
  const memberHolds = member ? Array.from(member.holds.values()).reduce((sum, count) => sum + count, 0) : 0;
  return JSON.stringify({ groupHolds: owner?.snapshot().holds ?? 0, memberHolds });
}

/** Takes a `stall-open-*` member's holds, then withholds the reply so it stays blocked mid-attach. */
function stallAttachments(owner: GroupOwner, tags: ReadonlyMap<number, string>, publish: (path: string, text: string) => void): void {
  const answer = owner.answer.bind(owner);
  const opens = new Map<string, number>();
  owner.answer = (member, data) => {
    const tag = tags.get(member.pid);
    if (data.op !== GROUP_OPEN || !tag?.startsWith(STALL_OPEN)) return answer(member, data);
    const count = (opens.get(tag) ?? 0) + 1;
    opens.set(tag, count);
    // The member's first attachment is its workerData gate; the message's objects follow it.
    if (count !== STALLED_OPEN) return answer(member, data);
    owner.dispatch(member, data.op, data.args);
    publish(`${CONTROL}/stalled/${tag}`, ownerHolds(owner, member));
  };
}

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
  const owners = new Map<string, GroupOwner>();
  const tags = new Map<number, string>();
  const groupOf = new Map<number, string>();
  const gone = new Set<number>();
  const retained = new Set<string>();
  const agentOf = new Map<string, string>();
  const locked = new Set<string>();
  const closed = new Set<string>();
  const releasedAt = new Map<string, number>();
  const delays: Record<string, number> = {};
  let querying = false;
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
  const bindAgent = (pid: number, tag: string) => {
    const agent = agents.get(children()?.get(pid)?.worker as Worker);
    if (!agent || agentOf.has(tag)) return;
    agent.tag = tag;
    agentOf.set(tag, agent.id);
  };
  const observeMember = (group: MemoryGroupSnapshot, pid: number) => {
    const tag = tags.get(pid) ?? tagOf(pid);
    if (tag === undefined) return;
    bindAgent(pid, tag);
    if (group.retained > 0 && tag.startsWith(FAIL_STOP) && !retained.has(tag)) {
      retained.add(tag);
      publish(`${CONTROL}/retained/${tag}`, "retained");
    }
    if (tags.has(pid)) return;
    tags.set(pid, tag);
    groupOf.set(pid, group.id);
    publish(`${CONTROL}/group/${tag}`, group.id);
  };
  const observeGroup = (group: MemoryGroupSnapshot, live: Set<number>) => {
    const owner = groups()?.groups.get(group.id);
    if (owner && !owners.has(group.id)) {
      owners.set(group.id, owner);
      stallAttachments(owner, tags, publish);
    }
    for (const pid of group.pids) {
      live.add(pid);
      observeMember(group, pid);
    }
  };
  const release = (pid: number, tag: string) => {
    gone.add(pid);
    releasedAt.set(tag, performance.now());
    publish(`${CONTROL}/gone/${tag}`, ownerHolds(owners.get(groupOf.get(pid) ?? "")));
  };
  const observeLock = (tag: string, id: string, present: ReadonlySet<string | undefined>) => {
    if (present.has(id)) { locked.add(tag); return; }
    if (!locked.has(tag) || closed.has(tag)) return;
    closed.add(tag);
    const released = releasedAt.get(tag);
    if (released !== undefined) delays[tag] = Math.round(performance.now() - released);
    publish(`${CONTROL}/closed/${tag}`, "closed");
  };
  const queryLocks = async () => {
    querying = true;
    const { held = [], pending = [] } = await navigator.locks.query();
    const present = new Set(held.concat(pending).map(lock => lock.name));
    for (const [tag, id] of agentOf) observeLock(tag, id, present);
    querying = false;
  };
  return {
    sample() {
      const live = new Set<number>();
      for (const group of processes.memoryGroups()) observeGroup(group, live);
      for (const [pid, tag] of tags) if (!live.has(pid) && !gone.has(pid)) release(pid, tag);
      if (!querying) void queryLocks();
    },
    settled: () => writes,
    ended: () => Array.from(owners.values(), owner => owner.snapshot()),
    budget: () => groups()?.budget.committed ?? -1,
    closeDelays: () => delays,
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
  installAgentWorkers();
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
  for (const directory of ["group", "gone", "closed", "stalled", "retained"]) await runtime.filesystem.mkdirp(`${CONTROL}/${directory}`);
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
  Reflect.set(globalThis, "sharedWasmMemoryProgress", () => ({ stdout: stdout.slice(-400), stderr: stderr.slice(-800), groups: processes.memoryGroups() }));
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
  // The broker releases a member only after its supported stop, which trails run.done. A failed
  // stop is debt that never settles here, so that run does not wait on the member it retains.
  const debt = entry === DEBT_ENTRY;
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline && processes.memoryGroups().some(group => group.members > 0 || (!debt && group.retained > 0))) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  members.sample();
  await members.settled();
  return { ...result, wallMs, stdout, stderr, peak, groups: processes.memoryGroups(), ended: members.ended(), budget: members.budget(), agentCloseDelays: members.closeDelays() };
}

void run().then(
  value => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, ...value }),
  (error: unknown) => Reflect.set(globalThis, "sharedWasmMemoryResult", { done: true, thrown: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }),
);
