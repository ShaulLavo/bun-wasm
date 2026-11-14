import assert from "node:assert/strict";
import { positives, faults, survivors, type EntryCommand } from "./controls.ts";
import { endpointIdentity, sameConnection, selectedClient, isRecord, positiveInteger, type Entry } from "./endpoint-identity.ts";

type Row = Record<string, unknown>;
function records(value: unknown): Row[] {
  assert(Array.isArray(value) && value.every(isRecord));
  return value;
}
export function commandOutcome(value: unknown, spec: EntryCommand) {
  assert(isRecord(value));
  assert.equal(value.done, true);
  assert(typeof value.code === "number" && Number.isSafeInteger(value.code));
  assert(typeof value.output === "string");
  if (spec.kind !== "fault") {
    assert.equal(value.error, null);
    assert.equal(value.code, 0);
    assert(spec.marker);
    assert.equal(value.output, spec.marker + "\n");
    assert(!spec.args.join(" ").includes(spec.marker));
    return value;
  }
  assert.notEqual(value.code, 0);
  assert(value.error === null || typeof value.error === "string");
  assert(!value.output.includes("FAULT_GUEST_UNEXPECTED"));
  return value;
}
function scope(raw: unknown) {
  assert(isRecord(raw));
  assert.equal(raw.source, "84ff8588028edcc013eb67aa4bb740b3a518b96d");
  assert(typeof raw.capture === "string" && raw.capture.length >= 32 && typeof raw.url === "string");
  const origin = new URL(raw.url).origin;
  const rows = records(raw.rows);
  for (const row of rows) {
    assert.equal(row.capture, raw.capture);
    assert.equal(row.origin, origin);
    assert.equal(row.pageURL, raw.url);
  }
  for (const key of ["originalRuntimeExposed", "originalFilesystem", "isolated"]) assert.equal(raw[key], true);
  assert.equal(raw.runtimeChanged, false);
  assert.equal(raw.runtimeRegistrations, 1);
  assert.equal(raw.contextCount, 1);
  assert.equal(raw.pageCount, 2);
  assert.equal(raw.engine, "browser");
  assert.equal(raw.profile, "split");
  assert(["hono", "vanilla"].includes(String(raw.template)));
  assert.equal(raw.template, new URL(raw.url).searchParams.get("template"));
  assert(isRecord(raw.filesystem));
  assert.equal(raw.filesystem.mode, "fast");
  assert.equal(raw.filesystem.implementation, "indexeddb");
  assert.equal(raw.filesystem.persistent, true);
  const services = rows.filter(row => row.kind === "endpoint" && row.stage === "before-original-handlers" && isRecord(row.snapshot) && row.snapshot.endpoint === "service");
  assert(services.length > 0 && services[0]?.mode === "fast" && services[0]?.implementation === "indexeddb");
  assert.equal(rows.filter(row => row.kind === "native-worker" && typeof row.url === "string" && new URL(row.url).pathname.endsWith("/fs-worker.js")).length, 1);
  assert.equal(rows.filter(row => row.kind === "native-error").length, 0);
  return { raw, rows, origin };
}
function samePosted(posted: unknown, before: Row, entry: Entry) {
  const identity = endpointIdentity(before, { endpoint: "client", entry });
  return identity !== null && isRecord(posted) && posted.owner === identity.owner && posted.generation === identity.generation
    && posted.pid === before.pid && posted.parentPid === before.parentPid && posted.processGeneration === before.processGeneration
    && typeof before.commandId === "string" && posted.commandId === before.commandId;
}
function client(rows: Row[], commandId: string, entry: Entry) {
  const before = rows.filter(row => row.stage === "before-original-handlers" && row.entry === entry && row.commandId === commandId);
  assert.equal(before.length, 1, `one ${entry} receive entry for ${commandId}`);
  const first = before[0]!;
  const identity = endpointIdentity(first, { endpoint: "client", entry });
  assert(identity && !identity.handlersQualified);
  const samePort = rows.filter(row => row.entry === entry && isRecord(row.snapshot) && row.snapshot.owner === identity.owner && row.snapshot.generation === identity.generation);
  assert(samePort.every(row => selectedClient(first, row, entry) && row.commandId === commandId));
  const serviceRows = rows.filter(row => {
    const service = endpointIdentity(row, { endpoint: "service" });
    return service !== null && sameConnection(identity, service);
  });
  assert(serviceRows.some(row => row.stage === "before-original-handlers" && isRecord(row.snapshot) && row.snapshot.handlersQualified === false));
  assert(serviceRows.some(row => row.stage === "service-original-handlers-qualified" && endpointIdentity(row, { endpoint: "service" })?.handlersQualified));
  assert(samePort.some(row => row.stage === "original-handlers-qualified" && endpointIdentity(row, { endpoint: "client", entry })?.handlersQualified));
  const posts = rows.filter(row => row.kind === "native-request-post" && samePosted(row.posted, first, entry));
  assert.equal(posts.length, 1);
  const post = posts[0]!;
  assert(positiveInteger(post.workerId));
  assert.equal(post.url, identity.workerURL);
  assert.equal(post.workerId, identity.workerId);
  assert.equal(first.workerIsolated, true);
  assert(rows.some(row => row.kind === "native-request-post-returned" && row.workerId === post.workerId && row.url === post.url && samePosted(row.posted, first, entry)));
  const native = rows.filter(row => row.kind === "native-message" && row.workerId === post.workerId && row.url === post.url && samePosted(row.posted, first, entry));
  return { before: first, identity, rows: samePort, serviceRows, post, native };
}
function entryReached(target: ReturnType<typeof client>) {
  assert(target.rows.some(row => row.stage === "after-original-preopen" && row.preopenCalls === 1 && row.posts === 1));
  assert(target.rows.some(row => row.stage === "original-instantiated" && row.instantiated === true));
  assert(target.rows.some(row => row.stage === "before-original-guest-entry" && row.guestEntry === true && row.instantiated === true));
  assert(target.rows.every(row => isRecord(row.snapshot) && row.snapshot.first === null));
}
function exitedZero(target: ReturnType<typeof client>) {
  const exits = target.native.filter(row => row.type === "exit");
  assert.equal(exits.length, 1);
  assert.equal(exits[0]?.code, 0);
}
export function qualifyCommand(raw: unknown, spec: EntryCommand) {
  const { rows } = scope(raw);
  const outcomes = rows.filter(row => row.kind === "original-command-completed" && row.commandId === spec.id);
  assert.equal(outcomes.length, 1);
  const outcome = commandOutcome(outcomes[0]?.outcome, spec);
  const root = client(rows, spec.id, "bun");
  assert.equal(root.before.parentPid, 0);
  const target = spec.entry === "bun" ? root : client(rows, spec.id, "shell");
  if (spec.entry === "shell") assert.equal(target.before.parentPid, root.before.pid);
  if (spec.kind !== "fault") {
    entryReached(root);
    assert(root.rows.some(row => row.stage === "original-browser-host-entry" && row.engine === "browser"));
    exitedZero(root);
    if (spec.entry === "shell") { entryReached(target); exitedZero(target); }
    assert.deepEqual(target.before.qualificationEnvironment, {});
    return { id: spec.id, entry: spec.entry, outcome, identity: target.identity, pid: target.before.pid, parentPid: target.before.parentPid, processGeneration: target.before.processGeneration, workerId: target.post.workerId };
  }
  assert.deepEqual(target.before.qualificationEnvironment, { QUALIFY_TARGET: spec.entry, QUALIFY_FAULT: spec.fault });
  assert(target.rows.some(row => row.stage === "after-original-preopen" && row.preopenCalls === 1 && row.posts === 0));
  assert(!target.rows.some(row => ["before-original-instantiate", "original-instantiated", "before-original-guest-entry", "original-browser-host-entry"].includes(String(row.stage))));
  const acknowledgements = target.native.filter(row => row.type === "error");
  assert.equal(acknowledgements.length, 1);
  const ack = acknowledgements[0]!;
  assert.equal(ack.errno, "EIO");
  assert(typeof ack.message === "string" && /\[code=CLOSED\]/.test(ack.message) && /\[errno=29\]/.test(ack.message));
  if (spec.entry === "bun") assert.equal(outcome.error, `bun.wasm crashed: ${ack.message}`.replace(/\r?\n/g, "\r\n"));
  else assert.equal(outcome.error, null);
  const localRows = spec.fault === "client" ? target.rows : target.serviceRows;
  const local = localRows.find(row => isRecord(row.snapshot) && isRecord(row.snapshot.first) && row.snapshot.first.kind === "messageerror");
  assert(local && isRecord(local.snapshot) && isRecord(local.snapshot.first));
  assert.equal(local.snapshot.handlersQualified, true);
  assert.equal(local.snapshot.first.trusted, false);
  assert.equal(local.snapshot.first.closedBefore, null);
  return { id: spec.id, entry: spec.entry, fault: spec.fault, outcome, identity: target.identity, pid: target.before.pid, parentPid: target.before.parentPid, processGeneration: target.before.processGeneration, workerId: target.post.workerId, ack, first: local.snapshot.first, synthetic: true, nativeCauseProved: false };
}
export function qualify(raw: unknown, phase: string) {
  const observed = scope(raw);
  const result = { positives: positives.map(spec => qualifyCommand(raw, spec)), controls: [] as ReturnType<typeof qualifyCommand>[], survivors: [] as ReturnType<typeof qualifyCommand>[], phase, nativeCauseProved: false, segmentDeserializationQualified: false };
  if (phase === "positives") {
    assert(!observed.rows.some(row => row.kind === "original-command-started" && faults.some(spec => spec.id === row.commandId)));
    return result;
  }
  for (const [index, spec] of faults.entries()) {
    result.controls.push(qualifyCommand(raw, spec));
    if (phase === spec.id) return result;
    const survivor = survivors[index]!;
    result.survivors.push(qualifyCommand(raw, survivor));
    if (phase === survivor.id) return result;
  }
  assert(phase === "before-original-dev" || phase === "final");
  if (phase === "final") {
    assert(isRecord(observed.raw.status) && observed.raw.status.kind === "ok");
    assert(isRecord(observed.raw.server) && observed.raw.server.port === 5173);
    assert(observed.rows.some(row => row.kind === "original-command-started" && row.commandId === "original-dev"));
  }
  return result;
}
