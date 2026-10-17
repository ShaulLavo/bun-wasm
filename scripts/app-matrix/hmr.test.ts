import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { observeHmr } from "./hmr.ts";

test("waits for Vite's connected message before editing and captures evidence before restore", async () => {
  const project = mkdtempSync("/work/tmp/bun-wasm-hmr-test-");
  try {
    const source = join(project, "main.js");
    writeFileSync(source, "const text = 'before';\n");
    let websocketListener: ((socket: { on(event: "framereceived", listener: (event: { payload: unknown }) => void): void }) => void) | undefined;
    let frameListener: ((event: { payload: unknown }) => void) | undefined;
    let observedDuringWait: string | undefined;
    let captured: string | undefined;
    const page = {
      on(_event: "websocket", listener: typeof websocketListener) { websocketListener = listener; },
      locator() {
        return { filter: () => ({ waitFor: async () => {
          observedDuringWait = readFileSync(source, "utf8");
          frameListener?.({ payload: JSON.stringify({ type: "update" }) });
        } }) };
      },
    };
    const verify = observeHmr(page);
    websocketListener?.({ on: (_event, listener) => { frameListener = listener; } });
    const pending = verify(project, "#app", { path: "main.js", search: "before", replacement: "after" }, 100, async () => {
      captured = readFileSync(source, "utf8");
    });
    expect(observedDuringWait).toBeUndefined();
    frameListener?.({ payload: JSON.stringify({ type: "connected" }) });
    await pending;
    expect(observedDuringWait).toBe("const text = 'after';\n");
    expect(captured).toBe("const text = 'after';\n");
    expect(readFileSync(source, "utf8")).toBe("const text = 'before';\n");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
