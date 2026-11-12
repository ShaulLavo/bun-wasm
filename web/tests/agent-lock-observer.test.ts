import { expect, test } from "bun:test";
import { AgentLockObserver, heldLockNames } from "./shared-wasm-agent/observer";

function observer() {
  const events: string[] = [];
  const watch = new AgentLockObserver({ armed: tag => events.push(`armed ${tag}`), closed: tag => events.push(`closed ${tag}`) });
  const agents = new Map([["member", "lock"]]);
  return { events, see: (snapshot: Parameters<typeof heldLockNames>[0]) => watch.observe(agents, heldLockNames(snapshot)) };
}

test("a pending request does not arm, and losing it is not a closure", () => {
  const { events, see } = observer();
  const pending = { held: [], pending: [{ name: "lock" }] };
  see(pending);
  see({ held: [], pending: [] });
  expect(events).toEqual([]);
});

test("an unnamed or missing held list arms nothing", () => {
  const { events, see } = observer();
  see({});
  see({ held: [{}] });
  expect(events).toEqual([]);
});

test("a held lock arms once, and only its release closes once", () => {
  const { events, see } = observer();
  const held = { held: [{ name: "lock" }] };
  see(held);
  see(held);
  expect(events).toEqual(["armed member"]);
  see({ held: [] });
  see({ held: [] });
  expect(events).toEqual(["armed member", "closed member"]);
});

test("a later agent is tracked independently of one that already closed", () => {
  const events: string[] = [];
  const watch = new AgentLockObserver({ armed: tag => events.push(`armed ${tag}`), closed: tag => events.push(`closed ${tag}`) });
  const agents = new Map([["first", "a"], ["second", "b"]]);
  watch.observe(agents, new Set(["a", "b"]));
  watch.observe(agents, new Set(["b"]));
  expect(events).toEqual(["armed first", "armed second", "closed first"]);
});
