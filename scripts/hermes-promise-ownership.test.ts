import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

function patchedPromise(): string {
  const root = resolve(import.meta.dir, "..");
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-hermes-promise-"));
  try {
    const directory = join(scratch, "lib/InternalJavaScript");
    mkdirSync(directory, { recursive: true });
    const output = join(directory, "01-Promise.js");
    writeFileSync(output, readFileSync(join(import.meta.dir, "fixtures/hermes-promise/01-Promise.js.txt")));
    const patch = readFileSync(join(root, "hermes/hermes-wasi.patch"), "utf8");
    const start = patch.indexOf("diff --git i/lib/InternalJavaScript/01-Promise.js ");
    assert.notEqual(start, -1);
    const end = patch.indexOf("\ndiff --git ", start + 1);
    assert.notEqual(end, -1);
    const applied = spawnSync("git", ["apply", "-"], { cwd: scratch, input: patch.slice(start, end + 1), encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const source = patchedPromise();

function control(body: string): void {
  const jobs: (() => void)[] = [];
  const sandbox = {
    HermesInternal: {
      useEngineQueue: () => true,
      test262Enabled: () => false,
      enqueueJob: (job: () => void) => { jobs.push(job); },
    },
    internalBytecodeResult: {},
    assert,
    jobs,
  };
  runInNewContext(source.concat("\n", body), sandbox, { timeout: 1000 });
  assert.equal(jobs.length, 0, "all expected reaction jobs were consumed");
}

test("owned evaluation rejection forwards despite refused handler-hook entry", () => {
  control(`
    let handleCalls = 0;
    let rejectCalls = 0;
    Promise._I(() => { rejectCalls++; }, () => {
      handleCalls++;
      throw new RangeError('simulated native tracker entry refusal');
    });
    for (const reason of [0, false, undefined, null, '', { original: true }]) {
      const source = Promise._O();
      const bridge = Promise._O();
      Promise._F(source, () => { assert.fail('rejected source must not fulfill'); }, bridge);
      assert.doesNotThrow(() => Promise._R(source, reason));
      assert.equal(source._y, 2);
      assert.equal(source._z, reason);
      assert.equal(bridge._y, 0);
      assert.equal(jobs.length, 1, 'only the forwarding reaction is queued');
      jobs.shift()();
      assert.equal(bridge._y, 2);
      assert.equal(bridge._z, reason);
      assert.equal(jobs.length, 0, 'OWNED sentinels enqueue no jobs');
    }
    assert.equal(handleCalls, 0);
    assert.equal(rejectCalls, 0);
  `);
});

test("fulfilled and already handled targets need no handler tracker", () => {
  control(`
    let handleCalls = 0;
    Promise._I(() => {}, () => { handleCalls++; });
    const source = Promise._O();
    const bridge = Promise._O();
    Promise._F(source, value => value + 1, bridge);
    Promise._V(source, 41);
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(bridge._y, 1);
    assert.equal(bridge._z, 42);
    let reject;
    const pending = new Promise((resolve, rejectValue) => { reject = rejectValue; });
    pending.catch(() => {});
    reject('handled before settlement');
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(handleCalls, 0);
  `);
});

test("settled owned adoption removes the user's stale rejection report", () => {
  control(`
    const reports = new Map();
    const handled = [];
    Promise._I((promise, reason) => reports.set(promise, reason), promise => {
      handled.push(promise);
      reports.delete(promise);
    });
    const reason = { original: true };
    const source = Promise.reject(reason);
    assert.equal(reports.get(source), reason);
    const adopted = Promise._O();
    Promise._V(adopted, source);
    assert.equal(reports.size, 0);
    assert.deepEqual(handled, [source]);
    const bridge = Promise._O();
    Promise._F(adopted, null, bridge);
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(bridge._y, 2);
    assert.equal(bridge._z, reason);
    assert.equal(reports.size, 0);
  `);
});

test("ordinary rejection tracking and observational reads remain intact", () => {
  control(`
    const reports = new Map();
    const handled = [];
    Promise._I((promise, reason) => reports.set(promise, reason), promise => {
      handled.push(promise);
      reports.delete(promise);
    });
    const reason = { ordinary: true };
    const source = Promise.reject(reason);
    assert.equal(source._y, 2);
    assert.equal(source._z, reason);
    assert.equal(reports.get(source), reason);
    const caught = source.catch(value => { assert.equal(value, reason); return 7; });
    assert.equal(reports.size, 0);
    assert.deepEqual(handled, [source]);
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(caught._y, 1);
    assert.equal(caught._z, 7);
  `);
});

test("guarded owned settlement keeps first resolution and rejection identity", () => {
  control(`
    const reason = { original: true };
    for (const value of [0, false, undefined, null, '', reason]) {
      const promise = Promise._O();
      Promise._V(promise, { then(resolve, reject) { reject(value); throw reason; } });
      assert.equal(promise._y, 2);
      assert.equal(promise._z, value);
    }
    const first = Promise._O();
    Promise._V(first, { then(resolve) { resolve(7); throw reason; } });
    Promise._R(first, reason);
    assert.equal(first._y, 1);
    assert.equal(first._z, 7);
    let reject;
    const pending = new Promise((resolve, rejectValue) => { reject = rejectValue; });
    const adopted = Promise._O();
    Promise._V(adopted, { then(resolve) { resolve(pending); throw reason; } });
    assert.equal(adopted._y, 3);
    reject(reason);
    assert.equal(pending._y, 2);
    assert.equal(pending._z, reason);
  `);
});

test("captured private hooks work after deletion and ignore public tracker properties", () => {
  control(`
    const create = Promise._O, forward = Promise._F, reject = Promise._R;
    Promise._I(() => { assert.fail('owned rejection was reported'); }, () => {
      assert.fail('owned promise entered the handler tracker');
    });
    for (const key of ['_I', '_O', '_F', '_R', '_V', '_T', '_G', '_S']) {
      delete Promise[key];
      assert.equal(Object.hasOwn(Promise, key), false);
    }
    Promise._B = Promise._C = () => { assert.fail('public tracker property was called'); };
    const source = create(), bridge = create();
    forward(source, null, bridge);
    const reason = { private: true };
    reject(source, reason);
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(bridge._y, 2);
    assert.equal(bridge._z, reason);
  `);
});
