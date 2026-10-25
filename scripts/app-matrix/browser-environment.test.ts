import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserCommand, browserLauncher, registryReplayUrl } from "./browser-environment";
import { nextApps } from "./product-next";
import { fullstackApps } from "./product-fullstack";

test("browser commands retain real CLI arguments and disable optional telemetry before import", () => {
  for (const app of nextApps.concat(fullstackApps)) {
    for (const command of app.commands) {
      expect(browserCommand(command.args)).toEqual(["bun", "run", ".matrix-command.ts"].concat(command.args.slice(1)));
    }
  }
  expect(browserLauncher).toContain('process.env.NEXT_TELEMETRY_DISABLED = "1"');
  expect(browserLauncher).toContain('process.env.ASTRO_TELEMETRY_DISABLED = "1"');
  expect(browserLauncher.indexOf("TELEMETRY_DISABLED")).toBeLessThan(browserLauncher.indexOf("await import"));
  expect(browserLauncher).toContain("process.argv.splice(1, 1)");
});

test("only the official Next version lookup is replayed through the recorded loopback registry", () => {
  const mirror = "http://127.0.0.1:12345";
  expect(registryReplayUrl("https://registry.npmjs.org/-/package/next/dist-tags", mirror)).toBe(`${mirror}/-/package/next/dist-tags`);
  for (const url of [
    "https://telemetry.nextjs.org/api/v1/record", "https://telemetry.astro.build/api/v1/record",
    "https://registry.npmjs.org/other", "https://registry.npmjs.org/-/package/next/dist-tags?x=1",
    "https://registry.npmjs.org.evil.invalid/-/package/next/dist-tags",
  ]) expect(registryReplayUrl(url, mirror)).toBeNull();
});

test("the browser runner installs and uses the environment launcher and registry replay", () => {
  const source = readFileSync(new URL("./browser.mjs", import.meta.url), "utf8");
  expect(source).toContain('writeFile(page, "/home/user/.matrix-command.ts", browserLauncher)');
  expect(source).toContain("browserCommand(command.args)");
  expect(source).toContain("registryReplayUrl(url.href, registry)");
  expect(source).toContain("return route.abort()");
});
