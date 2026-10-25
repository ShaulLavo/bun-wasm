import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BlockedBrowserNetworkError, networkGuardStage, runProductBrowserCase } from "./product-campaign";
import { productScoreboard, unlockCandidates, type ProductResultRow } from "./product-report";

test("a blocked external request remains an error but does not prevent later cases", async () => {
  const visited: string[] = [];
  const errors: string[] = [];
  const execute = async (app: string) => {
    visited.push(app);
    if (app === "blocked-next") throw new BlockedBrowserNetworkError(["https://telemetry.example.invalid/record"]);
  };
  for (const app of ["blocked-next", "later-vite"]) {
    const result = await runProductBrowserCase(() => execute(app));
    if (result.kind === "blocked-network") errors.push(result.message);
  }
  expect(visited).toEqual(["blocked-next", "later-vite"]);
  expect(errors).toEqual(["Browser attempted external network: https://telemetry.example.invalid/record"]);
});

test("unexpected infrastructure errors still stop the campaign", async () => {
  await expect(runProductBrowserCase(async () => { throw new Error("browser disappeared"); })).rejects.toThrow("browser disappeared");
});

test("blocked request evidence is snapshotted and deduplicated without allowing requests", async () => {
  const urls = ["https://external.invalid/", "https://external.invalid/"];
  const error = new BlockedBrowserNetworkError(urls);
  urls.push("https://later.invalid/");
  const result = await runProductBrowserCase(async () => { throw error; });
  expect(result).toMatchObject({ kind: "blocked-network", urls: ["https://external.invalid/"] });
});

test("network-contaminated case rows cannot become application passes or unlock counts", () => {
  const rows: ProductResultRow[] = [
    { app: "next", engine: "browser", host: "playground", stage: "install", status: "pass" },
    { app: "next", engine: "browser", host: "playground", stage: "dev", status: "fail", blocker: "SWC load failed" },
    { app: "next", engine: "browser", host: "playground", stage: networkGuardStage, status: "fail", blocker: "blocked network" },
  ];
  expect(productScoreboard(rows, [{ id: "next", commands: [{ name: "dev", check: { kind: "page" } }] }])).toContain("| next | Measurement error | Measurement error |");
  expect(unlockCandidates(rows)).toEqual([]);
});

test("runner keeps the network guard blocking at final exit and keeps request aborts", () => {
  const runner = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const browser = readFileSync(new URL("./browser.mjs", import.meta.url), "utf8");
  expect(runner).toContain("process.exitCode = infrastructureError || measurementErrors.length");
  expect(runner).toContain("blocked_external_network: measurementErrors");
  expect(browser).toContain("browserRegistryRoute(route, registry, external)");
  const route = readFileSync(new URL("./registry-request.ts", import.meta.url), "utf8");
  expect(route).toContain("return route.abort()");
  expect(browser).toContain("throw new BlockedBrowserNetworkError(external)");
});
