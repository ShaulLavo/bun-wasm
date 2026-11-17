import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInContext } from "node:vm";
import { eventTargetPortSource } from "./event-target-port-source";

test("actual web/events/port factories satisfy shared native ref and membership controls", () => {
  const source = eventTargetPortSource();
  const input = readFileSync(new URL("../tests/fixtures/event-target-port-ref/checks.ts", import.meta.url), "utf8")
    .replace(/^import .*;$/m, "const { MessageChannel } = ports;");
  try {
    runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(input.replace("export function", "function")) + "\nportRefChecks();", source.context);
    expect(source.lines).toHaveLength(6);
    expect(source.ticks).toHaveLength(0);
  } finally { runInContext("cleanup();", source.context); }
});

for (const mode of ["automatic", "explicit-ref", "explicit-unref"]) {
  for (const remains of [false, true]) {
    test(`restore recomputes ${mode} from canonical detached demand, remaining=${remains}`, () => {
      const source = eventTargetPortSource();
      Object.assign(source.context, { mode, remains });
      try {
        runInContext(`
          const { port2: port } = new ports.MessageChannel();
          const controller = new AbortController();
          port.addEventListener('message', () => {}, { signal: controller.signal });
          if (mode === 'explicit-ref') port.ref();
          if (mode === 'explicit-unref') port.unref();
          const stage = ports.__fixturePrepare(port).stage();
          stage.detach();
          controller.abort();
          if (remains) port.addEventListener('message', () => {});
          assert(!port.hasRef(), 'detached ref');
          stage.restore();
          assert(port.hasRef() === (mode === 'explicit-ref' || mode === 'automatic' && remains), 'restored logical ref');
        `, source.context);
        expect(source.ticks).toHaveLength(0);
      } finally { runInContext("cleanup();", source.context); }
    });
  }
}

for (const operation of ["add", "delete"]) {
  for (const when of ["before", "after"]) {
    test(`restore propagates ${when} ${operation} failure then rereads latest mode`, () => {
      const source = eventTargetPortSource();
      Object.assign(source.context, { operation, when });
      try {
        runInContext(`
          const { port2: port } = new ports.MessageChannel(), refs = internal.messagePortRefs;
          port.addEventListener('message', () => {});
          const stage = ports.__fixturePrepare(port).stage();
          stage.detach();
          if (operation === 'delete') port.unref();
          const original = refs[operation], failure = {};
          refs[operation] = function(state) {
            refs[operation] = original;
            if (when === 'before') throw failure;
            Reflect.apply(original, refs, [state]);
            throw failure;
          };
          let caught;
          try { stage.restore(); } catch (error) { caught = error; }
          assert(caught === failure, 'original restore error');
          assert(port.hasRef() === (operation === 'add' && when === 'after'), 'physical membership');
          if (operation === 'add') port.unref(); else port.ref();
          stage.restore();
          assert(port.hasRef() === (operation === 'delete'), 'latest mode on retry');
        `, source.context);
      } finally { runInContext("cleanup();", source.context); }
    });
  }
}

for (const change of ["remove", "add", "unref", "ref", "close"]) {
  for (const when of ["before", "after"]) {
    test(`restore reconciles reentrant ${change} ${when} physical write`, () => {
      const source = eventTargetPortSource();
      Object.assign(source.context, { change, when });
      try {
        runInContext(`
          const { port2: port } = new ports.MessageChannel(), refs = internal.messagePortRefs;
          const listener = () => {};
          if (change !== 'add' && change !== 'ref') port.addEventListener('message', listener);
          const stage = ports.__fixturePrepare(port).stage();
          stage.detach();
          const operation = change === 'add' || change === 'ref' ? 'delete' : 'add';
          const original = refs[operation];
          const mutate = () => {
            if (change === 'remove') port.removeEventListener('message', listener);
            else if (change === 'add') port.addEventListener('message', listener);
            else port[change]();
          };
          refs[operation] = function(state) {
            refs[operation] = original;
            if (when === 'before') mutate();
            const result = Reflect.apply(original, refs, [state]);
            if (when === 'after') mutate();
            return result;
          };
          stage.restore();
          assert(port.hasRef() === (change === 'add' || change === 'ref'), 'reentrant choice lost');
        `, source.context);
      } finally { runInContext("cleanup();", source.context); }
    });
  }
}

test("real worker initializer privately excludes one forwarder, keeps waiter demand and original forwarding", () => {
  const source = eventTargetPortSource();
  try {
    runInContext(`
      const { port2: port } = new ports.MessageChannel(), states = [port.hasRef()];
      port.ref = port.unref = () => { throw new Error('public ref used'); };
      const processHook = () => {};
      internal.listenerChanged = processHook;
      worker.initialize(port, { name: 'fixture', preload: [] }, event => new MessageEvent('message', { data: event.data }),
        (type, listener) => ports.__fixtureForward(port, type, listener));
      states.push(port.hasRef());
      onmessage = () => {};
      states.push(port.hasRef());
      assert(waiters[waiters.length - 1].ref, 'global waiter demand');
      const listener = () => {};
      EventTarget.prototype.addEventListener.call(port, 'message', listener);
      states.push(port.hasRef());
      EventTarget.prototype.removeEventListener.call(port, 'message', listener);
      states.push(port.hasRef());
      assert(states.join(',') === 'false,false,false,true,false', 'trusted exclusion');
      assert(internal.listenerChanged === processHook, 'process hook overwritten');
      let forwarded;
      onmessage = event => { forwarded = event.data; };
      port.dispatchEvent(new MessageEvent('message', { data: 4 }));
      assert(forwarded === 4, 'forwarding body');
      let duplicate = false;
      try { ports.__fixtureForward(port, 'message', () => {}); } catch { duplicate = true; }
      assert(duplicate, 'second trusted forwarder');
      onmessage = null;
      assert(!waiters[waiters.length - 1].ref, 'global waiter release');
      delete port.ref; delete port.unref;
    `, source.context);
    expect(source.ticks).toHaveLength(0);
  } finally { runInContext("delete port.ref; delete port.unref; cleanup();", source.context); }
});

for (const operation of ["add", "delete"]) {
  for (const when of ["before", "after"]) {
    test(`public ${operation === "add" ? "ref" : "unref"} commits mode across ${when} physical failure`, () => {
      const source = eventTargetPortSource();
      Object.assign(source.context, { operation, when });
      try {
        runInContext(`
          const { port2: port } = new ports.MessageChannel(), refs = internal.messagePortRefs;
          const listener = () => {};
          if (operation === 'delete') port.ref();
          const original = refs[operation], failure = {};
          refs[operation] = function(state) {
            refs[operation] = original;
            if (when === 'before') throw failure;
            Reflect.apply(original, refs, [state]);
            throw failure;
          };
          let caught;
          try { if (operation === 'add') port.ref(); else port.unref(); } catch (error) { caught = error; }
          assert(caught === failure, 'public error identity');
          const physical = operation === 'add' ? when === 'after' : when === 'before';
          assert(port.hasRef() === physical && port.hasRef() === physical, 'hasRef repaired failed operation');
          port.addEventListener('message', listener);
          port.removeEventListener('message', listener);
          assert(port.hasRef() === (operation === 'add'), 'explicit choice lost');
        `, source.context);
      } finally { runInContext("cleanup();", source.context); }
    });
  }
}

test("moved and closed wrappers cannot acquire refs, receiving wrappers start automatic", () => {
  const source = eventTargetPortSource();
  try {
    runInContext(`
      const { port2: port } = new ports.MessageChannel();
      port.ref();
      const plan = ports.__fixturePrepare(port);
      const stage = plan.stage();
      stage.detach(); stage.moved();
      port.addEventListener('message', () => {}); port.ref();
      assert(!port.hasRef(), 'moved ref');
      const { port2: closed } = new ports.MessageChannel();
      closed.close(); closed.ref(); closed.addEventListener('message', () => {});
      assert(!closed.hasRef(), 'closed ref');
      const { port2: receiver } = new ports.MessageChannel();
      const listener = () => {};
      receiver.addEventListener('message', listener);
      assert(receiver.hasRef(), 'automatic receiver add');
      receiver.removeEventListener('message', listener);
      assert(!receiver.hasRef(), 'automatic receiver remove');
    `, source.context);
  } finally { runInContext("cleanup();", source.context); }
});

test("trusted forwarder identity survives a committed insertion error", () => {
  const source = eventTargetPortSource();
  try {
    runInContext(`
      const { port2: port } = new ports.MessageChannel(), listener = () => {};
      const set = Map.prototype.set, failure = {};
      Map.prototype.set = function(key, value) {
        if (key !== 'message' || !Array.isArray(value) || value.length !== 2) return Reflect.apply(set, this, [key, value]);
        Map.prototype.set = set;
        throw failure;
      };
      let caught;
      try { ports.__fixtureForward(port, 'message', listener); } catch (error) { caught = error; }
      Map.prototype.set = set;
      // Existing-list push commits the listener even when the subsequent map write fails.
      assert(caught === failure, 'registration failure identity');
      EventTarget.prototype.removeEventListener.call(port, 'message', listener);
      ports.__fixtureForward(port, 'message', listener);
      assert(!port.hasRef(), 'trusted identity was visible as user demand');
      EventTarget.prototype.removeEventListener.call(port, 'message', listener);
      EventTarget.prototype.addEventListener.call(port, 'message', listener);
      assert(!port.hasRef(), 'bounded identity changed');
    `, source.context);
  } finally { runInContext("cleanup();", source.context); }
});

test("forwarder failure before insertion drops phantom exclusion and retries privately", () => {
  const source = eventTargetPortSource();
  try {
    runInContext(`
      const { port2: port } = new ports.MessageChannel(), listener = () => {};
      const push = Array.prototype.push, failure = {};
      Array.prototype.push = function(entry) {
        if (!entry || entry.listener !== listener) return Reflect.apply(push, this, arguments);
        Array.prototype.push = push;
        throw failure;
      };
      let caught;
      try { ports.__fixtureForward(port, 'message', listener); } catch (error) { caught = error; }
      Array.prototype.push = push;
      assert(caught === failure, 'before insertion identity');
      EventTarget.prototype.addEventListener.call(port, 'message', listener);
      assert(port.hasRef(), 'phantom exclusion');
      EventTarget.prototype.removeEventListener.call(port, 'message', listener);
      ports.__fixtureForward(port, 'message', listener);
      assert(!port.hasRef(), 'retry exclusion');
    `, source.context);
  } finally { runInContext("cleanup();", source.context); }
});

test("node removal reentry commits live demand and preserves the original emitter failure", () => {
  const source = eventTargetPortSource();
  try {
    runInContext(`
      const { port2: port } = new ports.MessageChannel(), listener = () => {}, replacement = () => {};
      const failure = {};
      port.on('message', listener);
      port.on('removeListener', type => { if (type === 'message') { port.on('message', replacement); throw failure; } });
      let caught;
      try { port.removeListener('message', listener); } catch (error) { caught = error; }
      assert(caught === failure && port.hasRef(), 'committed reentry/error');
      port.removeAllListeners('removeListener');
      port.removeListener('message', replacement);
      assert(!port.hasRef(), 'final node demand');
    `, source.context);
  } finally { runInContext("cleanup();", source.context); }
});
