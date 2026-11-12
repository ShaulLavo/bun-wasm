// The five-owner real-guest rows and their expected callback frames. Pure data: the guest
// orchestrator reads ids and stdin gates; scripts/io-resource-context.ts evaluates observations.
// A frame is the AsyncLocalStorage store name current in the callback; null is root.

export type Frame = string | null;
export type Value = string | number | boolean | null;
export type Observation = readonly [site: string, frame: Frame, ...values: Value[]];

/** The turn frame of a callback no resource owns: root on the hook path; elsewhere any frame but these. */
export interface TurnFrame { readonly turn: readonly Frame[] }
export type ExpectedFrame = Frame | TurnFrame;
export type Expected = readonly [site: string, frame: ExpectedFrame, ...values: Value[]];

export type Owner = "watch" | "ipc" | "spawn" | "stdin" | "serve";
/** `exact`: the whole record list in order. `sites`: per-site order, plus first occurrences in this order. */
export type Order = { readonly kind: "exact" } | { readonly kind: "sites"; readonly sequence: readonly string[]; readonly drainedBefore?: readonly [string, string] };
/** Bytes the orchestrator writes to the row's stdin, one per marker line the row prints. */
export interface StdinGate { readonly inputs: readonly string[]; readonly close: "after-inputs" | "after-exit" }

export interface Row {
  readonly owner: Owner;
  readonly expect: readonly Expected[];
  readonly order: Order;
  readonly stdin?: StdinGate;
  /** The row reports whether its blocked operation was still pending at its checkpoint. */
  readonly armed?: true;
}

const exact: Order = { kind: "exact" };
const sites = (...sequence: string[]): Order => ({ kind: "sites", sequence });
const turn = (...forbidden: Frame[]): TurnFrame => ({ turn: forbidden });
export const STDIN_MARKERS = ["READY", "GATE"] as const;
export const RESULT_FILE = "io-resource-context.result.json";

export const rows = {
  "watch.change-registration": { owner: "watch", order: exact, expect: [["caller", "unrelated"], ["change", "A", true]] },
  "watch.two-stores": { owner: "watch", order: sites(), expect: [["one", "one"], ["two", "two"]] },
  "watch.caller-close": { owner: "watch", order: exact, expect: [["caller", "unrelated"], ["close", "C"]] },
  "watch.abort": { owner: "watch", order: exact, expect: [["caller", "unrelated"], ["close", "D"]] },
  "watch.close-in-callback": { owner: "watch", order: exact, expect: [["change", "A"], ["close", "A"], ["queued", "A"]] },
  "watch.close-then-throw": { owner: "watch", order: exact, expect: [["change", "A"], ["error", "A", true], ["close", "A"]] },
  "ipc.message-eof": {
    owner: "ipc", order: { kind: "sites", sequence: ["message", "disconnect"], drainedBefore: ["message", "disconnect"] },
    expect: [["message", "A", 1], ["message", "A", 2], ["disconnect", "A"], ["exit", "A", 0]],
  },
  "ipc.caller-disconnect": {
    owner: "ipc", order: sites("message", "caller", "disconnect"),
    expect: [["message", "A", "ready"], ["caller", "A"], ["disconnect", "C"], ["exit", "A", 0]],
  },
  "ipc.immediate-send": {
    owner: "ipc", order: sites("message", "send"),
    expect: [["message", "A", "ready"], ["send", "B", null], ["message", "A", 1]],
  },
  "ipc.blocked-send": {
    owner: "ipc", order: sites("send-B", "send-D"), armed: true,
    expect: [["message", "A", "ready"], ["send-B", turn("B", "D"), null], ["send-D", turn("B", "D"), null], ["message", "A", 2]],
  },
  "spawn.bun-onexit": {
    owner: "spawn", order: exact,
    expect: [["caller", "unrelated"], ["onExit", "A", true, true, 3, null, null], ["exited", "reaction", 3]],
  },
  "spawn.startup-failure": {
    owner: "spawn", order: sites("threw", "caller"),
    expect: [["threw", "A", "ENOENT"], ["caller", "unrelated"], ["node-error", "A", "ENOENT"]],
  },
  "spawn.node-events": { owner: "spawn", order: exact, expect: [["spawn", "A"], ["exit", "A", 0], ["close", "A", 0]] },
  "stdin.construct-A-activate-B": {
    owner: "stdin", order: exact, stdin: { inputs: ["one\n"], close: "after-inputs" },
    expect: [["data", "B", "one\n"], ["end", "B"]],
  },
  "stdin.next-read-D": {
    owner: "stdin", order: exact, stdin: { inputs: ["one\n", "two\n"], close: "after-inputs" },
    expect: [["data", "B", "one\n"], ["data", "D", "two\n"], ["end", "D"]],
  },
  "stdin.pause-C-resume-D": {
    owner: "stdin", order: exact, stdin: { inputs: ["one\n", "two\n"], close: "after-inputs" },
    expect: [["data", "B", "one\n"], ["data", "D", "two\n"], ["end", "D"]],
  },
  "stdin.resume-C-redundant-D": {
    owner: "stdin", order: exact, stdin: { inputs: ["one\n", "two\n"], close: "after-inputs" },
    expect: [["data", "B", "one\n"], ["data", "C", "two\n"], ["end", "C"]],
  },
  "stdin.destroy-pending": {
    owner: "stdin", order: exact, stdin: { inputs: [], close: "after-exit" },
    expect: [["caller", "unrelated"], ["close", "C"]],
  },
  "serve.explicit-run-A": { owner: "serve", order: exact, expect: [["route", "A"], ["caller", "unrelated", "ok"]] },
  "serve.explicit-enterWith-A": { owner: "serve", order: exact, expect: [["route", "A"], ["caller", "unrelated", "ok"]] },
  "serve.root-registration": { owner: "serve", order: exact, expect: [["route", turn("F")], ["caller", "unrelated", "ok"]] },
  "serve.two-store-overlap": {
    owner: "serve", order: sites("overlap", "idle"),
    expect: [
      ["start:one", "A", "one"], ["start:two", "A", "two"], ["overlap", "A", true],
      ["after:one", "A", "one"], ["after:two", "A", "two"], ["idle", "A", null], ["caller", "unrelated", "idle"],
    ],
  },
} as const satisfies Record<string, Row>;

export type RowId = keyof typeof rows;
export const rowIds = Object.keys(rows) as RowId[];
export function isRowId(value: string): value is RowId {
  return Object.hasOwn(rows, value);
}

/** Required rows no public guest route can observe without a test ABI, fault injection or a mock. */
export const unqualified = [
  { id: "retirement.no-future-pump", owners: ["watch", "ipc", "spawn", "stdin", "serve"], reason: "Frame reachability after retirement needs a forced GC with no later I/O pump. Guests expose no GC trigger, and any wait yields to the pump that the row must exclude." },
  { id: "retirement.queued-before-release", owners: ["watch", "spawn", "stdin"], reason: "Collection after only the queued callback drains needs the same GC observer." },
  { id: "descriptor.once-only", owners: ["watch", "ipc", "spawn", "stdin", "serve"], reason: "No guest API lists descriptors. Rows prove release only by natural row-process exit with no referenced handle left." },
  { id: "ipc.blocked-send-failure-at-close", owners: ["ipc"], reason: "No native Bun error-callback contract was established for a blocked send failed by channel end." },
  { id: "ipc.no-callback-error-and-callback-throw", owners: ["ipc"], reason: "Not measured natively; a throwing send callback is an uncaught guest exception." },
  { id: "spawn.onexit-throws", owners: ["spawn"], reason: "A throwing onExit reaches the guest's uncaught-exception path and ends the row process." },
  { id: "spawn.throwing-stdin-or-abort-cleanup-with-ipc", owners: ["spawn", "ipc"], reason: "The fault needs a host step that throws during exit teardown. Public stdin callbacks and signal removal reach it only as an uncaught exception." },
  { id: "spawn.async-startup-onexit", owners: ["spawn"], reason: "Bun.spawn rejects a missing executable synchronously. The asynchronous status-2 onExit path needs a host service failure after admission." },
  { id: "stdin.read-error-and-destroy-in-data-throw", owners: ["stdin"], reason: "A guest cannot make its stdin descriptor fail. A throwing data listener is an uncaught exception." },
  { id: "serve.direct-fetch-reload-prepared-await", owners: ["serve"], reason: "Scope limit: direct server.fetch, reload and runtime-internal awaits are documented differences, not claimed parity." },
] as const;
