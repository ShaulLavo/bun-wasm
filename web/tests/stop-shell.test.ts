import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { stopShell } from "./stop-shell";

function fixture(runButton: { disabled: boolean } | null) {
  const shell = { running: true };
  const calls: string[] = [];
  const waiting = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const context = createContext({
    playground: { shell },
    document: { querySelector: () => runButton },
  });
  const page = {
    click: async (selector: string) => { calls.push(selector); },
    keyboard: { press: async (key: string) => { calls.push(key); } },
    async waitForFunction(expression: string) {
      calls.push("wait");
      expect(runInContext(expression, context)).toBe(false);
      waiting.resolve();
      await completion.promise;
      expect(runInContext(expression, context)).toBe(true);
    },
  };
  context.page = page;
  return {
    shell, calls, waiting: waiting.promise,
    stop: (): Promise<void> => runInContext(`(${stopShell.toString()})(page)`, context),
    finish() { shell.running = false; completion.resolve(); },
  };
}

for (const [name, button] of [["standalone UI without a Run button", null], ["page with an unrelated disabled Run button", { disabled: true }]] as const) {
  test(`stopShell waits for the shell to stop on ${name}`, async () => {
    const state = fixture(button);
    let stopped = false;
    const done = state.stop().then(() => { stopped = true; });
    try {
      await state.waiting;
      expect(state.calls).toEqual([".xterm", "Control+c", "wait"]);
      expect(state.shell.running).toBe(true);
      expect(stopped).toBe(false);
    } finally { state.finish(); }
    await done;
    expect(stopped).toBe(true);
  });
}

test("stopShell preserves errors from the stopped-shell wait", async () => {
  const error = new Error("shell is still running");
  const calls: string[] = [];
  const page = {
    click: async (selector: string) => { calls.push(selector); },
    keyboard: { press: async (key: string) => { calls.push(key); } },
    waitForFunction: async () => { throw error; },
  };
  const context = createContext({ page });
  await expect(runInContext(`(${stopShell.toString()})(page)`, context)).rejects.toBe(error);
  expect(calls).toEqual([".xterm", "Control+c"]);
});
