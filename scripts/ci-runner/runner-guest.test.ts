import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { validateRunnerSettings } from "./runner-guest.ts";

test("stock Runner UTF-8 settings preamble does not prevent startup validation", () => {
  const text = '\uFEFF{\n  "ephemeral": true,\n  "disableUpdate": true\n}';
  expect(() => JSON.parse(text)).toThrow();
  expect(() => validateRunnerSettings(text)).not.toThrow();
  expect(() => validateRunnerSettings(text.slice(1))).not.toThrow();
});

test.each([
  {}, { ephemeral: true }, { disableUpdate: true },
  { ephemeral: false, disableUpdate: true }, { ephemeral: true, disableUpdate: false },
  { ephemeral: "true", disableUpdate: true }, { ephemeral: true, disableUpdate: "true" },
  null, { Ephemeral: true, DisableUpdate: true },
])("settings still require both stock boolean flags: %j", value => {
  expect(() => validateRunnerSettings(`\uFEFF${JSON.stringify(value)}`)).toThrow("Runner must be ephemeral with automatic updates disabled");
});

test.each(["\uFEFF{", '\uFEFF{"ephemeral": true, "disableUpdate": true} trailing', '\uFEFF\uFEFF{"ephemeral": true, "disableUpdate": true}'])
  ("only one leading UTF-8 preamble is accepted, invalid JSON still fails: %j", text => {
    expect(() => validateRunnerSettings(text)).toThrow(SyntaxError);
  });

test("the guest Node entry can validate stock settings without starting a Listener on import", () => {
  const source = new URL("./runner-guest.ts", import.meta.url).href;
  const result = spawnSync("node", ["--input-type=module", "-e", `
    import { validateRunnerSettings } from ${JSON.stringify(source)};
    validateRunnerSettings('\uFEFF{"ephemeral":true,"disableUpdate":true}');
    try { validateRunnerSettings('\uFEFF{"ephemeral":false,"disableUpdate":true}'); process.exit(1); }
    catch (error) { if (error.message !== 'Runner must be ephemeral with automatic updates disabled') throw error; }
  `], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
