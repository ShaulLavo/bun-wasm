import { expect, test } from "bun:test";
import { assertAppProductionBuildID, assertProductionBrowserEvents, finishProduction, productionTemplate } from "./next-production-controls";

test("production acceptance rejects React hydration console errors", () => {
  expect(() => assertProductionBrowserEvents(["preview error: Hydration failed because the server rendered HTML did not match the client."])).toThrow();
});

test("production acceptance rejects failed JavaScript requests even with successful assets", () => {
  expect(() => assertProductionBrowserEvents(["preview requestfailed: http://preview/_next/static/page.js net::ERR_FAILED"])).toThrow();
});

test("a pending terminal read cannot prevent foreground and session cleanup", async () => {
  const terminal = Promise.withResolvers<string>();
  const calls: string[] = [];
  const done = finishProduction({
    readTerminal: () => terminal.promise,
    writeTerminal: () => calls.push("terminal"),
    stopForeground: async () => { calls.push("stop"); },
    close: async () => { calls.push("close"); },
    readTimeoutMs: 1,
  }).catch((error: unknown) => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toEqual(["stop", "close"]);
  } finally {
    terminal.resolve("late transcript");
    expect(await done).toMatchObject({ message: "Production terminal read timed out" });
  }
});

test("production acceptance keeps ordinary console output and warnings", () => {
  expect(() => assertProductionBrowserEvents(["preview log: this text contains error: but is not an error", "preview warning: diagnostic"])).not.toThrow();
});

for (const event of ["playground error: bootstrap failed", "preview pageerror: TypeError", "preview assert: failed assertion"]) {
  test(`production acceptance rejects ${event}`, () => {
    expect(() => assertProductionBrowserEvents([event])).toThrow();
  });
}

test("failed foreground cleanup still closes the browser and preserves the first error", async () => {
  const first = new Error("transcript failed");
  const calls: string[] = [];
  await expect(finishProduction({
    readTerminal: async () => { throw first; },
    writeTerminal: () => calls.push("terminal"),
    stopForeground: async () => { calls.push("stop"); throw new Error("stop failed"); },
    close: async () => { calls.push("close"); },
  })).rejects.toBe(first);
  expect(calls).toEqual(["stop", "close"]);
});

test("normal production teardown records the transcript before stopping and closing", async () => {
  const calls: string[] = [];
  await finishProduction({
    readTerminal: async () => "transcript",
    writeTerminal: text => calls.push(text),
    stopForeground: async () => { calls.push("stop"); },
    close: async () => { calls.push("close"); },
  });
  expect(calls).toEqual(["transcript", "stop", "close"]);
});

test("production template selection keeps Pages as the default and selects App explicitly", () => {
  expect(productionTemplate(undefined)).toEqual({ id: "next", editorPath: "/home/user/pages/index.tsx", heading: "Next.js in your browser" });
  expect(productionTemplate("next")).toEqual(productionTemplate(undefined));
  expect(productionTemplate("next-app")).toEqual({ id: "next-app", editorPath: "/home/user/app/page.tsx", heading: "Next.js App Router" });
  expect(() => productionTemplate("typo")).toThrow();
});

function flight(payload: string): string {
  return `self.__next_f.push(${JSON.stringify([1, payload])})`;
}

test("App production build identity comes from streamed Flight data, including split records", () => {
  const scripts = [
    '(self.__next_f=self.__next_f||[]).push([0]);',
    flight('1:I[123,[],"default"]\n0:{"b":"fresh-'),
    flight('build","f":[]}\n'),
    'self.__next_f.push([2,null])',
  ];
  expect(() => assertAppProductionBuildID(scripts, "fresh-build")).not.toThrow();
});

for (const [name, scripts] of [
  ["missing stream", []],
  ["stale build", [flight('0:{"b":"stale"}\n')]],
  ["missing build ID", [flight('0:{"f":[]}\n')]],
  ["build ID in another record only", [flight('1:{"b":"fresh-build"}\n0:{"b":"stale"}\n')]],
  ["unrelated script text", ['const data = {"b":"fresh-build"}']],
  ["Pages bootstrap only", ['<script id="__NEXT_DATA__">{"buildId":"fresh-build"}</script>']],
  ["malformed root record", [flight('0:not-json\n')]],
  ["root inside length-prefixed text before stale root", [flight('1:T23,not the root\n0:{"b":"fresh-build"}\n0:{"b":"stale"}\n')]],
  ["root inside length-prefixed text without actual root", [flight('1:T23,not the root\n0:{"b":"fresh-build"}\n')]],
  ["commented push call", [`/* ${flight('0:{"b":"fresh-build"}\n')} */`]],
  ["line-commented push call", [`// ${flight('0:{"b":"fresh-build"}\n')}`]],
  ["quoted push call", [JSON.stringify(flight('0:{"b":"fresh-build"}\n'))]],
  ["commented fresh root before stale root", [`/* ${flight('0:{"b":"fresh-build"}\n')} */`, flight('0:{"b":"stale"}\n')]],
  ["duplicate root", [flight('0:{"b":"fresh-build"}\n0:{"b":"stale"}\n')]],
] satisfies [string, string[]][]) {
  test(`App production acceptance rejects ${name}`, () => {
    expect(() => assertAppProductionBuildID(scripts, "fresh-build")).toThrow();
  });
}
