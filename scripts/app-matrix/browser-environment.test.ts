import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { createRuntime } from "../../node_modules/waffle/runtime";
import { examples } from "../../web/src/examples";
import { projectFiles } from "./apps.mjs";
import { request, type Route } from "playwright";
import { BlockedBrowserNetworkError, runProductBrowserCase } from "./product-campaign";
import { browserCommand, browserLauncher, resetBrowserProject } from "./browser-environment";
import { browserRegistryRoute, registryAccept, registryBrokerResponse, registryReplayUrl } from "./registry-request";
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
  expect(source).toContain("browserRegistryRoute(route, registry, external)");
  const isolate = readFileSync(new URL("./isolate.mjs", import.meta.url), "utf8");
  expect(isolate).toContain("fetch: registryBrokerResponse");
});

test("the recorder asks for ordinary JSON only for Next dist-tags", () => {
  expect(registryAccept("/-/package/next/dist-tags")).toBe("application/json");
  for (const path of ["/next", "/next/-/next-15.5.6.tgz", "/-/package/next/dist-tags?x=1"]) {
    expect(registryAccept(path)).toBe("application/vnd.npm.install-v1+json");
  }
});

async function replayControl(url: string, method = "GET", status = 200, reject = false) {
  const requests: { url: string; method: string; accept: string | null; retained: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(incoming) {
    requests.push({ url: incoming.url, method: incoming.method, accept: incoming.headers.get("accept"), retained: incoming.headers.get("x-matrix-control") });
    return new Response("recorded", { status });
  } });
  let client;
  try {
    client = await request.newContext();
    const api = client;
    const external: string[] = [];
    let aborted = false;
    let fulfilled = false;
    let continued = false;
    const route = {
      request: () => ({ url: () => url, method: () => method, headers: () => ({ accept: "application/vnd.npm.install-v1+json", "x-matrix-control": "retained" }) }),
      fetch: async (options: Parameters<Route["fetch"]>[0] = {}) => {
        if (reject) throw new Error("loopback registry unavailable");
        if (!options.url) throw new Error("Missing replay URL");
        return api.fetch(options.url, { ...options, headers: options.headers ?? route.request().headers() });
      },
      fulfill: async () => { fulfilled = true; },
      abort: async () => { aborted = true; },
      continue: async () => { continued = true; },
    };
    const measurement = await runProductBrowserCase(async () => {
      await browserRegistryRoute(route, `http://127.0.0.1:${server.port}`, external);
      if (external.length) throw new BlockedBrowserNetworkError(external);
    });
    return { measurement, requests, aborted, fulfilled, continued, base: `http://127.0.0.1:${server.port}` };
  } finally {
    await client?.dispose();
    await server.stop(true);
  }
}

const nextTags = "https://registry.npmjs.org/-/package/next/dist-tags";

test("the actual replay route forces JSON and retains other request headers", async () => {
  const control = await replayControl(nextTags);
  expect(control.requests).toEqual([{ url: `${control.base}/-/package/next/dist-tags`, method: "GET", accept: "application/json", retained: "retained" }]);
  expect(control.measurement).toEqual({ kind: "complete" });
  expect(control.fulfilled).toBe(true);
  expect(control.aborted).toBe(false);
});

test("a rejected loopback replay aborts and retains the raw URL as a network measurement error", async () => {
  const control = await replayControl(nextTags, "GET", 200, true);
  expect(control.measurement).toMatchObject({ kind: "blocked-network", urls: [nextTags] });
  expect(control.aborted).toBe(true);
  expect(control.fulfilled).toBe(false);
});

test("unsuccessful replays and all other external requests remain invalid", async () => {
  const failed = await replayControl(nextTags, "GET", 503);
  expect(failed.measurement).toMatchObject({ kind: "blocked-network", urls: [nextTags] });
  expect(failed.aborted).toBe(true);
  const rejected: [string, string][] = [[nextTags, "POST"], [`${nextTags}?x=1`, "GET"], ["https://telemetry.nextjs.org/api/v1/record", "GET"], ["https://telemetry.astro.build/api/v1/record", "GET"]];
  for (const [url, method] of rejected) {
    const control = await replayControl(url, method);
    expect(control.measurement).toMatchObject({ kind: "blocked-network", urls: [url] });
    expect(control.requests).toEqual([]);
    expect(control.aborted).toBe(true);
  }
  expect((await replayControl("http://127.0.0.1:12345/local")).continued).toBe(true);
});

test("the isolate broker rejects query variants instead of silently recording exact dist-tags", async () => {
  const upstream: string[] = [];
  const fixture = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    upstream.push(String(input));
    return Response.json({ latest: "fixture" });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fixture);
  try {
    const response = await registryBrokerResponse(new Request("http://recorder/-/package/next/dist-tags?x=1"));
    expect(response.status).toBe(502);
    expect(response.headers.get("x-bun-wasm-recorder-error")).toBe("1");
    expect(upstream).toEqual([]);
  } finally { fetch.mockRestore(); }
});

test("the isolate broker sends JSON only for the exact path and retains package Accept", async () => {
  const headers: (HeadersInit | undefined)[] = [];
  const fixture = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], options?: Parameters<typeof globalThis.fetch>[1]) => {
    headers.push(options?.headers);
    return Response.json({ latest: "fixture" });
  }, { preconnect: globalThis.fetch.preconnect });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(fixture);
  try {
    for (const path of ["/-/package/next/dist-tags", "/next"]) expect((await registryBrokerResponse(new Request(`http://recorder${path}`))).ok).toBe(true);
    expect(headers.map(value => new Headers(value).get("accept"))).toEqual(["application/json", "application/vnd.npm.install-v1+json"]);
  } finally { fetch.mockRestore(); }
});

test("executing the launcher retains direct Bun normalized argv and sets telemetry before the CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-argv-"));
  try {
    expect(dirname(directory)).toBe(tmpdir());
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested/cli.ts"), 'console.log(JSON.stringify({ argv: process.argv, next: process.env.NEXT_TELEMETRY_DISABLED, astro: process.env.ASTRO_TELEMETRY_DISABLED }));');
    writeFileSync(join(directory, ".matrix-command.ts"), browserLauncher);
    const args = ["run", "nested/cli.ts", "dev", "--hostname", "127.0.0.1", "--port", "3137"];
    const direct = Bun.spawnSync([process.execPath].concat(args), { cwd: directory });
    const wrapped = Bun.spawnSync([process.execPath].concat(browserCommand(args).slice(1)), { cwd: directory, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "0", ASTRO_TELEMETRY_DISABLED: "0" } });
    expect(direct.exitCode).toBe(0);
    expect(wrapped.exitCode).toBe(0);
    const original = JSON.parse(direct.stdout.toString());
    const actual = JSON.parse(wrapped.stdout.toString());
    expect(actual.argv).toEqual(original.argv);
    expect(actual.next).toBe("1");
    expect(actual.astro).toBe("1");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the launcher fixture honors a TMPDIR override and removes its files", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-argv-env-"));
  try {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.filename, "--test-name-pattern", "^executing the launcher retains direct Bun normalized argv"], {
      env: { ...process.env, CI: "true", TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    expect(result.stderr.toString()).toContain("(pass) executing the launcher retains direct Bun normalized argv and sets telemetry before the CLI");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fixture admission removes all seeded and stale project files, not runtime files", async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../../node_modules/waffle/browser/fs-worker.ts", import.meta.url) } });
  const fs = runtime.filesystem;
  try {
    await fs.mkdirp("/home/user/stale/nested");
    for (const [path, contents] of Object.entries(examples)) await fs.writeFile(`/home/user/${path}`, contents);
    await fs.writeFile("/home/user/stale/nested/unrelated.ts", "export const stale = true;");
    await fs.writeFile("/home/user/.matrix-command.ts", "stale launcher");
    await fs.mkdirp("/usr/local/lib");
    await fs.writeFile("/usr/local/lib/runtime.ts", "preserved runtime");
    expect(await fs.readFile("/home/user/db.ts")).toBeDefined();
    await runInNewContext(`(${resetBrowserProject.toString()})()`, { globalThis: { playground: { fs } } });
    expect(await fs.listFiles("/home/user")).toEqual([]);
    const app = nextApps.find(app => app.id === "next-15-pages");
    if (!app) throw new Error("Missing Next pages fixture");
    const files: Record<string, string> = projectFiles(app, "http://127.0.0.1:12345");
    for (const [path, contents] of Object.entries(files)) await fs.writeFile(`/home/user/${path}`, contents);
    expect((await fs.listFiles("/home/user")).sort()).toEqual(Object.keys(files).map(path => `/home/user/${path}`).sort());
    for (const [path, contents] of Object.entries(files)) expect(new TextDecoder().decode(await fs.readFile(`/home/user/${path}`))).toBe(contents);
    expect(new TextDecoder().decode(await fs.readFile("/usr/local/lib/runtime.ts"))).toBe("preserved runtime");
    await runInNewContext(`(${resetBrowserProject.toString()})()`, { globalThis: { playground: { fs } } });
    expect(await fs.listFiles("/home/user")).toEqual([]);
  } finally { await runtime.dispose(); }
});

test("the browser clears fixture sources after readiness and before project overlay or install", () => {
  const source = readFileSync(new URL("./browser.mjs", import.meta.url), "utf8");
  const ready = source.indexOf("if (!(await ready(page)).includes");
  const reset = source.indexOf("await page.evaluate(resetBrowserProject)", ready);
  const write = source.indexOf("Object.entries(projectFiles(app, registry))", ready);
  const install = source.indexOf('await run(page, "bun install"', ready);
  expect(ready).toBeGreaterThanOrEqual(0);
  expect(reset).toBeGreaterThan(ready);
  expect(write).toBeGreaterThan(reset);
  expect(install).toBeGreaterThan(write);
});
