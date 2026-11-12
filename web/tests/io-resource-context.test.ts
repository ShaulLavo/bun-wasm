import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

type Records = (string | number | boolean | null)[][];
type Output = { results: Record<string, Records>; retirement?: Record<string, boolean[]> };

const fixture = new URL("./fixtures/io-resource-context.ts", import.meta.url).pathname;
function run(mode: "hooks" | "native"): Output {
  const result = spawnSync("node", ["--expose-gc", "--disable-warning=ExperimentalWarning", fixture, mode], { encoding: "utf8", timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const line = result.stdout.split("\n").find(value => value.startsWith("IO_RESOURCE_CONTEXT "));
  expect(line, result.stdout).toBeDefined();
  return JSON.parse(line!.slice("IO_RESOURCE_CONTEXT ".length));
}

// The same frames with the host's frame slot (reset to root every turn) and with a native
// continuation provider (left in an unrelated frame): the resource's own frame wins in both.
const EXPECTED: Record<string, Records> = {
  "spawn stdin callback failure closes IPC": [["caller restored", "caller-C"], ["disconnect", "channel-A"]],
  "spawn abort cleanup failure closes IPC": [["caller restored", "caller-C"], ["disconnect", "channel-A"]],
  "watch change": [["change", "A", true]],
  "watch error": [["error", "A", "EIO"], ["close", "A"]],
  "watch close then throw": [["change", "A"], ["error", "A", true], ["close", "A"]],
  "watch error listener throws": [["error", "A", "EIO"], ["error", "A", true], ["close", "A"]],
  "watch caller pump": [["change", "A"], ["error", "A", true], ["caller", "caller"], ["close", "A"]],
  "watch caller close": [["close", "C"]],
  "watch abort": [["close", "D"]],
  "watch two stores": [["one", "one"], ["two", "two"]],
  "watch closed earlier in the turn": [["other", "other"], ["close", "other"]],
  "spawn onExit": [["onExit", "A", true, true, 0, null, null], ["exited reaction", "reaction", 0]],
  "spawn startup error": [["onExit", "A", null, null, "ENOENT"], ["exited reaction", "reaction", "ENOENT"]],
  "spawn onExit throws": [["onExit", "A"], ["exited reaction", "reaction", 0], ["queued by onExit", "A"]],
  "node spawn events": [["spawn", "A"], ["exit", "A"], ["close", "A"]],
  "ipc message and end": [["message", "A", 1], ["disconnect", "A"]],
  "ipc caller disconnect": [["disconnect", "C"]],
  "ipc immediate send": [["send", "B", null]],
  "ipc drained at exit": [["message", "A", 1], ["message", "A", 2], ["disconnect", "A"], ["exit", "A"]],
  "ipc finish from another frame": [["message", "A", 1], ["disconnect", "A"]],
  "stdin construct A, read B": [["data", "B", "one"], ["end", "B"]],
  "stdin construct root, read B": [["data", "B", "one"], ["end", "B"]],
  "stdin construct A, read root": [["data", null, "one"], ["end", null]],
  "stdin next read D": [["data", "B", "one"], ["data", "D", "two"], ["end", "D"]],
  "stdin pause C, resume D": [["data", "B", "one"], ["data", "D", "two"], ["end", "D"]],
  "stdin resume C, read D pending": [["data", "B", "one"], ["data", "C", "two"], ["end", "C"]],
  "stdin destroyed in data, then throws": [["data", "B"], ["close", "B"]],
  "stdin read error": [["error", "B", "EIO"], ["close", "B"]],
  "serve explicit frame": [["route", "A"]],
  "serve run frame": [["route", "A"]],
};

// Not a resource's own event, so unchanged: the turn's frame, which is root on the hook path and
// the unrelated ambient frame with a native provider. A send completed by a later pump (native
// Bun reports no frame, Node the send's), a send failed by the channel's end (no native contract
// established), and a request to a server started outside any frame.
function turnFrame(frame: string | null): Record<string, Records> {
  return {
    "ipc blocked send": [["send", frame, null]],
    "ipc partial message at exit": [["message", "A", 1], ["pending send", frame, "ERR_IPC_CHANNEL_CLOSED"], ["disconnect", "A"]],
    "serve root registration": [["route", frame]],
  };
}

const hooks = run("hooks");
const native = run("native");

test("pump-driven resource callbacks run in their resource's frame on the hook path", () => {
  expect(hooks.results).toEqual({ ...EXPECTED, ...turnFrame(null) });
});

test("pump-driven resource callbacks run in their resource's frame with a native continuation provider", () => {
  expect(native.results).toEqual({ ...EXPECTED, ...turnFrame("unrelated") });
});

// One entry per step: true while the retained resource or a callback it queued still holds the
// frame. No step pumps again after the resource retired.
test("a retired resource does not keep its frame once its queued callbacks ran, without another pump", () => {
  expect(hooks.retirement).toEqual({
    "spawn stdin callback throws with IPC open": [true, false],
    "spawn abort removal throws with IPC open": [true, false],
    "watch closed without a pump": [true, false],
    "watch closed in its dispatch": [true, true, false],
    "watch close then throw": [true, false],
    "watch closed earlier in the turn": [true, false],
    "spawn exits": [true, false],
    "spawn exits without onExit": [true, false],
    "serve stopped": [true, false],
    "ipc closed by its caller": [true, false],
    "ipc ended by its input": [true, false],
    "stdin destroyed with a read pending": [true, false],
    "stdin read to its end": [true, true, false],
    // Exit cancels waiters but closes no resource; the realm ends with it.
    "watch at exit cancellation": [true, true],
    "spawn cleanup throws": [true, false],
  });
});
