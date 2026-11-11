import { afterEach, expect, spyOn, test } from "bun:test";
import { method, models } from "./ui-model-helpers";

const cleanups: (() => Promise<void>)[] = [];
const originalBuilds = Object.getOwnPropertyDescriptor(globalThis, "__bunwasmBuilds");
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (originalBuilds) Object.defineProperty(globalThis, "__bunwasmBuilds", originalBuilds);
  else Reflect.deleteProperty(globalThis, "__bunwasmBuilds");
});

async function fixture(builds: Record<string, string> = {}) {
  Reflect.set(globalThis, "__bunwasmBuilds", builds);
  const page = await models();
  cleanups.push(page.cleanup);
  return page;
}

const pair = { "bun-spidermonkey.wasm": "a".repeat(64), "spidermonkey-engine.wasm": "b".repeat(64) };

test("a staged SpiderMonkey pair is selectable from the ordinary Browser playground", async () => {
  const page = await fixture(pair);
  const playground = new page.Playground("");
  playground.ready = true;
  const markup = await page.renderPlayground(playground);
  expect(markup.match(/<option[^>]*value="spidermonkey"[^>]*>/)?.[0]).toBe('<option value="spidermonkey">');
  for (const engine of ["browser", "quickjs", "jsc"]) expect(markup).toContain(`value="${engine}"`);
  expect(markup).toContain('value="browser" selected');
});

for (const builds of [{}, { "bun-spidermonkey.wasm": pair["bun-spidermonkey.wasm"] }, { "spidermonkey-engine.wasm": pair["spidermonkey-engine.wasm"] }]) {
  test(`SpiderMonkey stays visible but unavailable with manifest entries ${Object.keys(builds).join(", ") || "absent"}`, async () => {
    const page = await fixture(builds);
    const markup = await page.renderPlayground(new page.Playground(""));
    const option = markup.match(/<option[^>]*value="spidermonkey"[^>]*>/)?.[0];
    expect(option).toContain("disabled");
    expect(markup).toContain("SpiderMonkey (not in this build)");
  });
}

test("an explicitly selected unavailable SpiderMonkey reports the pair staging prerequisite", async () => {
  const page = await fixture();
  const playground = new page.Playground("?engine=spidermonkey");
  const error = await method<() => Promise<unknown>>(playground, "loadEngine")();
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("SPIDERMONKEY_WASM");
  expect(String(error)).toContain("spidermonkey-engine.wasm");
  expect(page.loads).toEqual([]);
  const markup = await page.renderPlayground(playground);
  expect(markup.match(/value="spidermonkey"/g)).toHaveLength(1);
  expect(markup.match(/<option[^>]*value="spidermonkey"[^>]*>/)?.[0]).toContain("selected");
});

for (const [query, tier] of [
  ["?engine=spidermonkey", "interp"],
  ["?engine=spidermonkey&measurement-arm=spidermonkey-pbl&measurement-tier=pbl", "pbl"],
] as const) {
  test(`SpiderMonkey startup supplies ${tier} to the ordinary shell and loads its own core`, async () => {
    const page = await fixture(pair);
    const playground = new page.Playground(query);
    method<() => void>(playground, "terminalOpened")();
    await playground.start();
    expect(playground.failure).toBeUndefined();
    expect(playground.ready).toBe(true);
    expect(page.loads).toEqual(["bun-spidermonkey.wasm"]);
    expect(page.sessionCreates[0]?.env).toMatchObject({
      BUN_WASM_SPIDERMONKEY_TIER: tier,
      PATH: "/opt/bun/spidermonkey/bin:/bin",
    });
    expect(playground.status.text).toContain("SpiderMonkey");
  });
}

test("selecting SpiderMonkey keeps workspace parameters and removes the custom core override", async () => {
  const page = await fixture(pair);
  page.boundary.location.href = "https://example.test/?template=vite-react&mode=memory&wasm=custom.wasm";
  const assign = spyOn(page.boundary.location, "assign");
  const playground = new page.Playground("?template=vite-react&mode=memory&wasm=custom.wasm");
  playground.chooseEngine("spidermonkey");
  expect(assign).toHaveBeenCalledTimes(1);
  const url = new URL(String(assign.mock.calls[0]?.[0]));
  expect(url.searchParams.get("engine")).toBe("spidermonkey");
  expect(url.searchParams.get("template")).toBe("vite-react");
  expect(url.searchParams.get("mode")).toBe("memory");
  expect(url.searchParams.has("wasm")).toBe(false);
  assign.mockRestore();
});
