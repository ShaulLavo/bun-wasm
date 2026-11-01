import assert from "node:assert/strict";

const appPhases = ["handle-request-dev", "handle-request-base", "find-page-components-dev", "find-page-components-parent", "render-components"];
export const routeCoverage = {
  "api/context": { required: appPhases, status: 200, sender: "handler-owned" },
  dynamic: { required: appPhases, status: 200, sender: "handler-owned" },
  "missing-acceptance": { required: appPhases.concat(["ensure-page"]), status: 404, sender: "handler-owned" },
  "phase-sender-control": { required: appPhases.concat(["send-render-result"]), status: 200, sender: "class-sender" },
} satisfies Record<string, { required: readonly string[]; status: number; sender: string }>;
export type CoveredRoute = keyof typeof routeCoverage;
export type PhaseRecord = Record<string, unknown> & { stage: string; probe: string; at: number; requestId: number };

// Stage only in the separately authorized diagnostic fixture, never the normal app.
export const phaseSenderControl = {
  path: "pages/phase-sender-control.tsx",
  source: 'export function getServerSideProps() { return { props: { marker: "NEXT phase class sender" } }; }\nexport default function Page({ marker }: { marker: string }) { return <main>{marker}</main>; }\n',
};

export function observerRecords(terminal: string, probe: string): PhaseRecord[] {
  return terminal.split("\n").flatMap(line => {
    const prefix = "[guest-error-phase] ";
    if (!line.startsWith(prefix)) return [];
    let value: unknown;
    try { value = JSON.parse(line.slice(prefix.length)); } catch { return []; }
    if (!value || typeof value !== "object" || !("probe" in value) || value.probe !== probe) return [];
    assert.ok("stage" in value && typeof value.stage === "string", `Invalid stage ${probe}`);
    assert.ok("at" in value && typeof value.at === "number" && Number.isFinite(value.at), `Invalid timestamp ${probe}`);
    assert.ok("requestId" in value && typeof value.requestId === "number" && Number.isSafeInteger(value.requestId) && value.requestId > 0, `Invalid request object identity ${probe}`);
    return [{ ...value, probe, stage: value.stage, at: value.at, requestId: value.requestId }];
  });
}

export function verifyTaggedPhaseCoverage(terminal: string, probe: string, route: CoveredRoute): PhaseRecord[] {
  const records = observerRecords(terminal, probe);
  assert.ok(records.length, `Missing tagged records ${probe}`);
  assert.equal(new Set(records.map(record => record.requestId)).size, 1, `Each ${probe} phase must belong to one request object`);
  assert.ok(records.every(record => record.correlation === "request-object-async-context"), `Missing exact identity ${probe}`);
  verifyRequestAndWriter(records, route, probe);
  for (const name of routeCoverage[route].required) verifyInterval(records, name, probe);
  if (routeCoverage[route].sender !== "class-sender" && records.some(record => record.stage.startsWith("send-render-result:"))) verifyInterval(records, "send-render-result", probe);
  return records;
}

function one(records: readonly PhaseRecord[], stage: string, probe: string): PhaseRecord {
  const matches = records.filter(record => record.stage === stage);
  assert.equal(matches.length, 1, `Expected one ${probe}/${stage}`);
  const record = matches[0];
  assert.ok(record);
  return record;
}

function verifyRequestAndWriter(records: readonly PhaseRecord[], route: CoveredRoute, probe: string): void {
  const event = one(records, "request-event", probe);
  assert.equal(event.requestIsIncomingMessage, true, `Missing incoming request object ${probe}`);
  assert.equal(event.responseIsServerResponse, true, `Missing HTTP response object ${probe}`);
  const request = one(records, "request", probe);
  assert.equal(request.method, "GET", `Wrong tagged request method ${probe}`);
  assert.ok(typeof request.url === "string" && request.url.startsWith("/"), `Missing request URL ${probe}`);
  assert.equal(new URL(request.url, "https://fixture.invalid").pathname, `/${route}`, `Wrong tagged route ${probe}`);
  verifyWriter(records, "writeHead", probe);
  verifyWriter(records, "end", probe);
  const ended = one(records, "end:return", probe);
  const finished = one(records, "finish", probe);
  assert.equal(ended.status, routeCoverage[route].status, `Wrong HTTP writer status ${probe}`);
  assert.equal(finished.status, routeCoverage[route].status, `Wrong HTTP finish status ${probe}`);
  assert.equal(ended.headersSent, true, `HTTP headers not sent ${probe}`);
  assert.ok(ended.at >= request.at && finished.at >= request.at, `HTTP writer precedes request ${probe}`);
}

function verifyWriter(records: readonly PhaseRecord[], name: string, probe: string): void {
  const entry = one(records, `${name}:entry`, probe);
  const returned = one(records, `${name}:return`, probe);
  assert.ok(returned.at >= entry.at, `Invalid HTTP writer interval ${probe}/${name}`);
}

function verifyInterval(records: readonly PhaseRecord[], name: string, probe: string): void {
  const entries = records.filter(record => record.stage === `${name}:entry`);
  assert.ok(entries.length, `Missing ${probe}/${name}:entry`);
  assert.equal(new Set(entries.map(entry => entry.callId)).size, entries.length, `Duplicate call identity ${probe}/${name}`);
  for (const entry of entries) verifyCall(records, name, probe, entry);
}

function verifyCall(records: readonly PhaseRecord[], name: string, probe: string, entry: PhaseRecord): void {
  assert.ok(typeof entry.callId === "number" && Number.isSafeInteger(entry.callId) && entry.callId > 0, `Missing call identity ${probe}/${name}`);
  const calls = records.filter(record => record.callId === entry.callId);
  const returned = one(calls, `${name}:return`, probe);
  const resolved = one(calls, `${name}:resolve`, probe);
  assert.ok(returned.at >= entry.at && resolved.at >= returned.at, `Invalid same-call interval ${probe}/${name}`);
}


export const phaseControlRequests = [
  { probe: "phase-handler-context", route: "api/context" },
  { probe: "phase-normal-dynamic", route: "dynamic" },
  { probe: "phase-normal-missing", route: "missing-acceptance" },
  { probe: "phase-class-sender", route: "phase-sender-control" },
  { probe: "phase-overlap-a", route: "dynamic" },
  { probe: "phase-overlap-b", route: "dynamic" },
] satisfies readonly { probe: string; route: CoveredRoute }[];

export function verifyPhaseObservationControls(terminal: string) {
  const controls = phaseControlRequests.map(control => ({ ...control, records: verifyTaggedPhaseCoverage(terminal, control.probe, control.route) }));
  assert.equal(new Set(controls.map(control => control.records[0]?.requestId)).size, controls.length, "Control requests need distinct object identities");
  const overlap = controls.filter(control => control.probe === "phase-overlap-a" || control.probe === "phase-overlap-b");
  const starts = overlap.map(control => one(control.records, "request", control.probe).at);
  const ends = overlap.map(control => one(control.records, "end:return", control.probe).at);
  assert.ok(Math.max(...starts) < Math.min(...ends), "Tagged same-URL requests must actually overlap");
  return { controls: controls.map(control => ({ probe: control.probe, route: control.route, requestId: control.records[0]?.requestId })), directLoadComponentsTiming: false };
}
