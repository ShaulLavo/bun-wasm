// The real NestedHost against Waffle's real group owner. Only the worker-side port is replaced,
// by direct owner calls, so every acquisition, refusal and rollback is counted by the owner itself.
import { GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { MemoryGroups } from "../node_modules/waffle/group/state.ts";
import { NestedHost, type RegionProvider } from "../src/nested/host";
import type { Reply, Request } from "../src/nested/wire";

export const PAGE = 65536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Lease = ReturnType<MemoryGroups["admit"]>;
export type Owner = NonNullable<ReturnType<MemoryGroups["owner"]>>;
export type ReplyOf<K extends string> = Extract<Reply, Record<K, unknown>>;
type Policy = NonNullable<ConstructorParameters<typeof MemoryGroups>[0]>;

export interface Member {
  readonly lease: Lease;
  readonly owner: Owner;
  readonly host: NestedHost;
  send(request: Request): Reply;
  raw(op: number, a?: number, b?: number, c?: number, d?: number): number[];
  /** The core's callback dispatcher. It answers status 0 and leaves the frame; a test may replace it. */
  dispatch: Dispatch;
}
type Dispatch = (invocation: number, callback: number, pointer: number) => number;

function bindMember(lease: Lease, owner: Owner): Member {
  const { memory, port } = lease.launch().request;
  port.close();
  const raw = (op: number, a = 0, b = 0, c = 0, d = 0) => owner.request(lease, op, a, b, c, d);
  const [status, , base] = raw(GroupOp.CREATE, 1 << 20, 16);
  if (status !== 0) throw new Error("heap region");
  let next = base!;
  const view = () => new DataView(memory.buffer);
  const answer = (out: number, count: number, op: number, a: number, b = 0, c = 0, d = 0) => {
    const values = raw(op, a, b, c, d);
    if (values[0]! < 0) return values[0]!;
    for (let index = 0; index < count; index++) view().setUint32(out + index * 4, values[index + 1]! >>> 0, true);
    return 0;
  };
  const provider: RegionProvider = {
    shm_create: (length, align, out) => answer(out, 2, GroupOp.CREATE, length, align),
    shm_detach: handle => raw(GroupOp.DETACH, handle)[0]!,
    shm_publish: (kind, primary, companion, meta, out) => answer(out, 1, GroupOp.PUBLISH, kind, primary, companion, meta),
    shm_publication_open: (token, kind, out) => answer(out, 7, GroupOp.OPEN, token, kind),
    shm_withdraw: token => raw(GroupOp.WITHDRAW, token)[0]!,
    futex_wait32: () => 2,
    futex_wait64: () => 2,
    futex_wake: () => 0,
  };
  const alloc = (size: number, align: number) => {
    const pointer = Math.ceil(next / align) * align;
    next = pointer + size;
    return pointer;
  };
  const host = new NestedHost(() => {}, () => {});
  host.bindProvider(provider);
  const core: Pick<Member, "dispatch"> = { dispatch: () => 0 };
  const exports = { bun_core_alloc: alloc, bun_core_free: () => {}, bun_nested_dispatch: (...frame: Parameters<Dispatch>) => core.dispatch(...frame) };
  host.bindCore({ exports } as unknown as WebAssembly.Instance, memory);
  const exchange = (request: Request): Reply => {
    const bytes = encoder.encode(JSON.stringify(request));
    const pointer = alloc(bytes.length, 8);
    new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
    const out = alloc(8, 8);
    host.imports.request(pointer, bytes.length, out);
    const target = view().getUint32(out, true);
    const length = view().getUint32(out + 4, true);
    return JSON.parse(decoder.decode(new Uint8Array(memory.buffer, target, length).slice())) as Reply;
  };
  /** Nothing a request allocates outlives its reply, so thousands of requests fit the one heap region. */
  const send = (request: Request): Reply => {
    const mark = next;
    try { return exchange(request); }
    finally { next = mark; }
  };
  return Object.assign(core, { lease, owner, host, send, raw });
}

/** One page's groups under a small policy. Each `join()` is a new group; `join(peer)` joins the peer's. */
export function group(policy: Partial<Policy> = {}) {
  const groups = new MemoryGroups({ maximumPages: 512, stackBytes: PAGE, ...policy });
  let pid = 1;
  const join = (peer?: Member) => {
    const lease = groups.admit(pid++, "nested", peer ? peer.lease.group : "new");
    return bindMember(lease, groups.owner(lease.group)!);
  };
  return { groups, join };
}

export function handle(reply: Reply): number { return (reply as ReplyOf<"Handle">).Handle; }
export function count(reply: Reply): number { return (reply as ReplyOf<"Count">).Count; }
export function errorText(reply: Reply): string { return (reply as ReplyOf<"Error">).Error.message; }
export function counters(owner: Owner) {
  const { regions, holds, pins, published, watches } = owner.snapshot();
  return { regions, holds, pins, published, watches };
}
