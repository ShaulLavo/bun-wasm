import { expect, test } from "bun:test";
import { processRuntimeFixture } from "./process-runtime-fixture.ts";

test("process fixture accepts adapter-free commands and retains adapter validation", async () => {
  const runtime = processRuntimeFixture({});
  const command = { load: async () => async () => 0 };
  try {
    const unregister = runtime.registerProgram("/command", { command });
    expect(() => runtime.registerProgram("/command", { command })).toThrow("already registered");
    unregister();
    runtime.registerProgram("/command", { command })();
    expect(() => runtime.registerProgram("/missing", { adapter: "missing", source: new Uint8Array() })).toThrow("Unknown adapter: missing");
  } finally { await runtime.dispose(); }
});
