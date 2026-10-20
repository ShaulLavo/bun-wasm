import { writeFileSync } from "node:fs";
import { verifyServerContract, type ServerObservation, type ServerRequest } from "./server-contract.ts";

interface Page {
  evaluate<Arg, Result>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>;
}

function browserRequest(page: Page, base: string, timeout: number): ServerRequest {
  return request => page.evaluate(async ({ base, request, timeout }) => {
    const response = await fetch(new URL(request.path, base), {
      method: request.method, headers: request.headers, body: request.body,
      signal: AbortSignal.timeout(timeout), cache: "no-store", redirect: "error",
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }, { base, request, timeout });
}

export async function verifyBrowserServer(page: Page, base: string, framework: string, timeout: number, evidence: string): Promise<string> {
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller), null);
  if (!controlled) throw new Error("Preview is not controlled by a service worker");
  const observations: ServerObservation[] = [];
  return verifyServerContract(framework, browserRequest(page, base, timeout), observation => {
    observations.push(observation);
    writeFileSync(evidence, JSON.stringify({ base, framework, serviceWorkerControlled: controlled, observations }, null, 2) + "\n");
  });
}

async function assertStoppedPreview(page: Page, base: string, timeout: number, evidence: string): Promise<void> {
  const response = await browserRequest(page, base, timeout)({ path: "", method: "GET", headers: {}, status: 502 });
  writeFileSync(evidence, JSON.stringify({ base, response }, null, 2) + "\n");
  if (response.status !== 502 || !response.body.includes("No bun.wasm server is listening")) throw new Error(`Preview survived guest stop: HTTP ${response.status}`);
}

export async function stoppedPreviewError(page: Page, base: string, timeout: number, evidence: string): Promise<string | undefined> {
  try { await assertStoppedPreview(page, base, timeout, evidence); }
  catch (error) { return String(error); }
}
