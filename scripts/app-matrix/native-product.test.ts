import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { browserHost } from "./browser.mjs";
import { completeObservations, type ProductPage } from "./product-browser";
import { fullstackApps } from "./product-fullstack";
import type { ProductCommand } from "./product-types";

function nativeControl(project: string, broken: string) {
  const source = join(project, "src/routes/index.tsx");
  const visits: string[] = [];
  const waits: string[] = [];
  const pageErrors: Array<(error: Error) => void> = [];
  const frames: Array<(event: { payload: string }) => void> = [];
  const sockets: Array<(value: typeof socket) => void> = [];
  const marker = "bun-wasm product matrix";
  let count = 0;
  let closed = 0;
  let query = "initial";
  const socket = {
    on(_event: string, listener: (event: { payload: string }) => void) { frames.push(listener); },
  };
  const emit = (payload: string) => { for (const listener of frames) listener({ payload }); };
  const locator = (selector: string, text = ""): ReturnType<ProductPage["locator"]> => ({
    filter: ({ hasText }: { hasText: string }) => locator(selector, hasText),
    async waitFor() {
      waits.push(`${selector}:${text}`);
      if (selector === "#server-value" && text !== query) throw new Error("query DOM differs");
      if (selector === "#count" && text !== String(count)) throw new Error("counter did not change");
      if (selector !== "#product-marker") return;
      if (!readFileSync(source, "utf8").includes(text)) throw new Error("source marker differs");
      if (text !== marker && broken !== "hmr") emit('{"type":"update","updates":[{"type":"js-update","path":"/src/routes/index.tsx"}]}');
    },
    async click() {
      if (broken === "client-pageerror") {
        const error = new Error("Client action threw");
        for (const listener of pageErrors) listener(error);
        return;
      }
      if (broken !== "client-interaction") count++;
    },
    async count() { return 0; },
  });
  const page = {
    on(event: string, listener: (value: typeof socket | Error) => void) {
      if (event === "websocket") sockets.push(value => listener(value));
      if (event === "pageerror") pageErrors.push(error => listener(error));
    },
    async goto(url: string) {
      visits.push(url);
      query = new URL(url).searchParams.get("value") ?? "initial";
      count = 0;
      for (const listener of sockets) listener(socket);
      emit('{"type":"connected"}');
      return {
        ok: () => true, status: () => broken === "ssr-query" && query !== "initial" ? 500 : 200,
        text: async () => query, headers: () => ({}),
      };
    },
    locator,
    context: () => ({ close: async () => { closed++; } }),
    screenshot: async () => {},
  };
  return {
    state: { visits, waits, closed: () => closed },
    launchServer: async () => ({ wsEndpoint: () => "fixture", close: async () => {}, kill: async () => {}, process: () => ({ exitCode: 0, signalCode: null }) }),
    connect: async () => ({ newPage: async () => page }),
  };
}

async function runNative(command: ProductCommand, broken = "") {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "native-product-"));
  const previous = process.env.PLAYWRIGHT;
  let host: Awaited<ReturnType<typeof browserHost>> | undefined;
  try {
    const fixture = fullstackApps.find(app => app.id === "fullstack-solidstart");
    if (!fixture) throw new Error("SolidStart fixture missing");
    for (const [path, contents] of Object.entries(fixture.files)) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), contents);
    }
    const adapter = join(directory, "playwright.ts");
    writeFileSync(adapter, `import { readFileSync } from "node:fs"; import { join } from "node:path";\nexport const chromium = (${nativeControl.toString()})(${JSON.stringify(directory)}, ${JSON.stringify(broken)});`);
    process.env.PLAYWRIGHT = adapter;
    const { chromium } = await import(pathToFileURL(adapter).href);
    host = await browserHost({
      root: resolve(import.meta.dir, "../.."), options: { timeout: 100, output: directory },
      launch: () => { throw new Error("Must not launch an app"); }, stop: () => { throw new Error("No app child exists"); },
    });
    const result = await host.checkPage("http://native.invalid/", command.check, directory, 100);
    return {
      result, rows: completeObservations(command.check, "observations" in result ? result.observations : [], result),
      visits: chromium.state.visits, waits: chromium.state.waits, closed: chromium.state.closed(),
      original: readFileSync(join(directory, "src/routes/index.tsx"), "utf8") === fixture.files["src/routes/index.tsx"],
    };
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT;
    else process.env.PLAYWRIGHT = previous;
    try { await host?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function stage(name: string): ProductCommand {
  const command = fullstackApps.find(app => app.id === "fullstack-solidstart")?.commands.find(command => command.name === name);
  if (!command) throw new Error(`SolidStart ${name} missing`);
  return command;
}

for (const name of ["dev", "start"]) {
  test(`native SolidStart ${name} executes every registered dependent check`, async () => {
    const run = await runNative(stage(name));
    expect(run.result.status).toBe("pass");
    const expected = name === "dev" ? ["hmr", "ssr-query", "query-dom", "client-interaction"] : ["ssr-query", "query-dom", "client-interaction"];
    expect(run.rows.map(row => [row.stage, row.status])).toEqual(expected.map(id => [id, "pass"]));
    expect(run.visits).toEqual(["http://native.invalid/", "http://native.invalid/?value=fullstack-request-value", "http://native.invalid/?value=fullstack-request-value", "http://native.invalid/"]);
    expect(run.waits).toContain("#count:1");
    expect(run.original).toBe(true);
    expect(run.closed).toBe(1);
    if (name === "dev") expect("assertion" in run.result && run.result.assertion).toContain('source edit renders "bun-wasm product matrix updated" after a Vite WebSocket update');
  });
}

for (const broken of ["ssr-query", "client-interaction"]) {
  test(`native SolidStart records an attempted ${broken} failure without hiding the other probes`, async () => {
    const run = await runNative(stage("start"), broken);
    expect(run.result.status).toBe("pass");
    expect(run.rows.find(row => row.stage === broken)).toMatchObject({ status: "fail" });
    expect(run.rows.filter(row => row.stage !== broken).every(row => row.status === "pass")).toBe(true);
    expect(run.rows).toHaveLength(3);
    expect(run.closed).toBe(1);
  });
}

test("native SolidStart still rejects a source edit without a WebSocket update", async () => {
  const run = await runNative(stage("dev"), "hmr");
  expect(run.result.status).toBe("fail");
  expect("blocker" in run.result && run.result.blocker).toContain("Source edit rendered without a Vite WebSocket update");
  expect(run.rows.every(row => row.status === "blocked")).toBe(true);
  expect(run.original).toBe(true);
  expect(run.closed).toBe(1);
});

for (const name of ["dev", "start"]) {
  test(`native SolidStart ${name} keeps attempted observations when an action emits a page error`, async () => {
    const run = await runNative(stage(name), "client-pageerror");
    expect(run.result.status).toBe("fail");
    expect("productError" in run.result && run.result.productError).toContain("Client action threw");
    const expected = name === "dev" ? ["hmr", "ssr-query", "query-dom", "client-interaction"] : ["ssr-query", "query-dom", "client-interaction"];
    expect(run.rows.map(row => [row.stage, row.status])).toEqual(expected.map(id => [id, id === "client-interaction" ? "fail" : "pass"]));
    expect(run.rows.find(row => row.stage === "client-interaction")).toMatchObject({ blocker: "Error: counter did not change" });
    expect(run.original).toBe(true);
    expect(run.closed).toBe(1);
  });
}
