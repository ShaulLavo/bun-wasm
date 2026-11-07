import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPageSuite, type SuiteAdapter } from "waffle/testing/page-runner";
import { processAdapter } from "./process-ios-adapter";
import type { ProcessRequest } from "./process-page-adapter";

async function scratch<T>(run: (path: string) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "process-host-"));
  try { return await run(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

test("the public host rejects future and nonfinite same-process start values before allocation", async () => {
  await scratch(async root => {
    let allocations = 0;
    const driver = () => { allocations++; throw new Error("must not allocate a driver"); };
    for (const startedAt of [NaN, Infinity, -Infinity, performance.now() + 10_000]) {
      await expect(runPageSuite(processAdapter, driver, { resultPath: join(root, "result.json"), startedAt })).rejects.toThrow("same-process monotonic timestamp");
    }
    expect(allocations).toBe(0);
    expect(existsSync(join(root, "result.json"))).toBe(false);
  });
});

test("the public host expires the original absolute budget before preparation or driver allocation", async () => {
  await scratch(async root => {
    let preparations = 0, allocations = 0;
    const adapter: SuiteAdapter<ProcessRequest> = { ...processAdapter, async assets() { preparations++; return {}; } };
    const result = await runPageSuite(adapter, () => { allocations++; throw new Error("driver must not be allocated"); }, {
      startedAt: performance.now() - 120_001, resultPath: join(root, "result.json"), scratchRoot: join(root, "host"),
    });
    expect(result.exit).toBe(2);
    expect(result.failures.some(failure => failure.category === "run-timeout")).toBe(true);
    expect(preparations).toBe(0);
    expect(allocations).toBe(0);
    expect(existsSync(join(root, "host"))).toBe(false);
  });
});

test("synchronous preparation cannot allocate a driver after spending the real host deadline", async () => {
  await scratch(async root => {
    let preparations = 0, allocations = 0;
    const adapter: SuiteAdapter<ProcessRequest> = {
      ...processAdapter,
      budgets: selected => ({ ...processAdapter.budgets(selected), run: 40 }),
      async assets() {
        preparations++;
        const until = performance.now() + 75;
        while (performance.now() < until) { /* Exercise the synchronous preparation boundary, not a timer callback. */ }
        return {};
      },
    };
    const result = await runPageSuite(adapter, () => { allocations++; throw new Error("driver must not be allocated"); }, {
      resultPath: join(root, "result.json"), scratchRoot: join(root, "host"),
    });
    expect(preparations).toBe(1);
    expect(allocations).toBe(0);
    expect(result.exit).toBe(2);
    expect(result.failures.some(failure => failure.category === "run-timeout")).toBe(true);
    expect(result.cleanup.server.status).toBe("not-created");
    expect(result.cleanup.scratch.status).toBe("confirmed");
  });
});

test("interrupt during preparation settles the producer before scratch cleanup without later dispatch", async () => {
  await scratch(async root => {
    const entered = deferred();
    const interruption = new AbortController();
    const events: string[] = [];
    let allocations = 0, retainedDuringJoin = false;
    const adapter: SuiteAdapter<ProcessRequest> = {
      ...processAdapter,
      async assets({ signal, scratch: owned }) {
        events.push("prepare");
        entered.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        retainedDuringJoin = existsSync(owned);
        events.push("joined");
        signal.throwIfAborted();
        return {};
      },
    };
    const pending = runPageSuite(adapter, () => { allocations++; throw new Error("driver must not be allocated"); }, {
      resultPath: join(root, "result.json"), scratchRoot: join(root, "host"), signal: interruption.signal,
    });
    try { await entered.promise; }
    finally { interruption.abort(); }
    const result = await pending;
    expect(events).toEqual(["prepare", "joined"]);
    expect(retainedDuringJoin).toBe(true);
    expect(allocations).toBe(0);
    expect(result.exit).toBe(2);
    expect(result.cleanup.scratch.status).toBe("confirmed");
  });
});
