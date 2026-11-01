import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { terminalText } from "../../web/tests/playground.mjs";
import { assertPreviewPageOrigin } from "./next-acceptance-admission";
import { requestProbe } from "./next-acceptance-http";
import { requireServingObserver } from "./next-acceptance-observer";
import { phaseControlRequests, routeCoverage, verifyPhaseObservationControls } from "./next-acceptance-phase-coverage";

type Control = typeof phaseControlRequests[number];
type Response = Awaited<ReturnType<typeof requestProbe>>;

export function verifyPhaseControlResponse(control: Control, response: Response): void {
  assert.equal(response.kind, "complete", `Control ${control.probe} must reach EOF`);
  assert.equal(response.status, routeCoverage[control.route].status, `Control ${control.probe} HTTP status`);
  assert.ok(response.bytesRead > 0, `Control ${control.probe} has no response bytes`);
  if (control.route === "missing-acceptance") { assert.ok(response.body.includes("NEXT-01 missing")); return; }
  if (control.route === "phase-sender-control") { assert.ok(response.body.includes("NEXT phase class sender")); return; }
  if (control.route === "api/context") requireServingObserver(response.body);
  if (control.route === "dynamic") assert.ok(response.body.includes("server-original"));
  const normalized = response.body.replaceAll("&quot;", '"');
  for (const field of ["header", "cookie", "after", "cookieAfter"]) {
    assert.ok(normalized.includes(`"${field}":"${control.probe}"`), `Control ${control.probe} lost ${field}`);
  }
}

export async function runPhaseObservationControl(page: Page, base: string, timeout: number, owner: Page, output: string) {
  assertPreviewPageOrigin(page.url(), base);
  const deadline = Date.now() + timeout;
  await phaseCookies(page, false);
  const responses: { control: Control; response: Response }[] = [];
  const request = async (control: Control) => {
    const response = await requestProbe(page, { url: new URL(control.route, base).href, deadline,
      expectedStatus: routeCoverage[control.route].status,
      headers: { "x-bun-writer-probe": control.probe, "x-next-marker": control.probe } });
    responses.push({ control, response });
    writeFileSync(join(output, "phase-control-responses.json"), JSON.stringify(responses, null, 2) + "\n");
    verifyPhaseControlResponse(control, response);
  };
  try {
    for (const control of phaseControlRequests.slice(0, 4)) await request(control);
    const overlapping = phaseControlRequests.slice(4).map(request);
    const results = await Promise.allSettled(overlapping);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  } finally {
    await phaseCookies(page, true);
  }
  const terminal = await terminalText(owner);
  writeFileSync(join(output, "phase-control.log"), terminal);
  const coverage = verifyPhaseObservationControls(terminal);
  writeFileSync(join(output, "phase-coverage-qualified.json"), JSON.stringify({ ...coverage,
    evidence: "serving-worker-terminal-and-completed-http-responses", invalidEditAllowed: true, at: Date.now() }, null, 2) + "\n");
}

async function phaseCookies(page: Page, clear: boolean): Promise<void> {
  await page.evaluate(({ controls, clear }) => {
    for (const control of controls) document.cookie = `next-marker-${control.probe}=${clear ? "; max-age=0" : control.probe}; path=/`;
  }, { controls: phaseControlRequests, clear });
}

export async function runObservedRecovery(page: Page, probe: string, operation: () => Promise<void>): Promise<void> {
  await page.setExtraHTTPHeaders({ "x-bun-error-phase-probe": probe });
  try { await operation(); }
  finally { await page.setExtraHTTPHeaders({}); }
}
