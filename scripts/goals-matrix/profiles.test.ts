import { expect, test } from "bun:test";
import { options, playgroundURL } from "./run";
import { nativeRunnerArgs } from "./fleet";
import { frameworks } from "./catalog";
import { ready } from "./playground";
import { withPlayground } from "./test-fixture";

const framework = frameworks.find(item => item.id === "vite-react");
if (!framework) throw new Error("Vite React template is missing");
const args = ["--asset-source=profile-test", "--engines=quickjs,jsc", "--browsers=safari", "--mac-lane=profile-test", "--mac-thread=profile-test"];

test("goals profile selection reaches both playground URLs and the remote FIFO runner", () => {
  expect(options(args).profile).toBe("split");
  const config = options(args.concat("--profile=shared-group"));
  expect(config.profile).toBe("shared-group");
  expect(options(nativeRunnerArgs(config, "/Users/test/goals")).profile).toBe("shared-group");
  const url = new URL(playgroundURL("http://test/", framework, "jsc", config.profile));
  expect(url.searchParams.get("profile")).toBe("shared-group");
  expect(new URL(playgroundURL("http://test/", framework, "browser")).searchParams.get("profile")).toBe("split");
  expect(() => options(args.concat("--profile=unknown"))).toThrow("Unknown Bun program profile");
  for (const engine of ["browser", "spidermonkey"]) {
    expect(() => options([`--engines=${engine}`, "--asset-source=test", "--profile=shared-group"])).toThrow("does not support");
  }
});

test("readiness reads the running profile instead of trusting a requested URL or engine label", () => withPlayground(framework, 0, async transport => {
  expect(await ready(transport, "browser", 100)).toHaveProperty("profile", "split");
  await expect(ready(transport, "browser", 100, "shared-group")).rejects.toThrow("expected shared-group, observed split");
  await transport.evaluate('playground.profile = "shared-group"');
  expect(await ready(transport, "browser", 100, "shared-group")).toHaveProperty("profile", "shared-group");
  await expect(ready(transport, "browser", 100, "split")).rejects.toThrow("expected split, observed shared-group");
}));
