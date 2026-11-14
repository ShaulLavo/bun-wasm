import { association } from "./worker-transport.ts";
export type Entry = "bun" | "shell";
type Endpoint = "client" | "service";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function webURL(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function endpointIdentity(value: unknown, expected: { endpoint: Endpoint; entry?: Entry }) {
  if (!isRecord(value) || !isRecord(value.snapshot) || !association(value) || value.runtimeId !== value.capture) return null;
  const state = value.snapshot;
  if (state.endpoint !== expected.endpoint) return null;
  if (state.realm !== (expected.endpoint === "client" ? "native-client" : "native-service")) return null;
  if (!positiveInteger(state.owner) || !positiveInteger(state.generation)) return null;
  if (typeof state.tree !== "string" || !state.tree || typeof state.handlersQualified !== "boolean") return null;
  const worker = webURL(state.workerURL), module = webURL(value.moduleURL);
  if (!worker || !module || worker.origin !== module.origin) return null;
  const suffix = expected.endpoint === "service" ? "/fs-worker.js" : expected.entry === "bun" ? "/__bunwasm/worker.js" : "/shell-worker.js";
  if (!worker.pathname.endsWith(suffix)) return null;
  if (expected.endpoint === "client" && (value.entry !== expected.entry || !positiveInteger(value.pid) || !positiveInteger(value.processGeneration))) return null;
  if (expected.endpoint === "client" && (typeof value.parentPid !== "number" || !Number.isSafeInteger(value.parentPid) || value.parentPid < 0)) return null;
  return { runtimeId: value.runtimeId, workerId: value.workerId, endpoint: state.endpoint, owner: state.owner, generation: state.generation, tree: state.tree,
    realm: state.realm, workerURL: worker.href, moduleURL: module.href, handlersQualified: state.handlersQualified };
}

export function sameConnection(first: NonNullable<ReturnType<typeof endpointIdentity>>, second: NonNullable<ReturnType<typeof endpointIdentity>>) {
  return first.runtimeId === second.runtimeId && first.owner === second.owner && first.generation === second.generation && first.tree === second.tree
    && new URL(first.workerURL).origin === new URL(second.workerURL).origin;
}

export function selectedClient(before: unknown, candidate: unknown, entry: Entry) {
  if (!isRecord(before) || !isRecord(candidate)) return false;
  const first = endpointIdentity(before, { endpoint: "client", entry });
  const current = endpointIdentity(candidate, { endpoint: "client", entry });
  if (!first || !current || !sameConnection(first, current)) return false;
  if (typeof before.capture !== "string" || before.capture.length < 32) return false;
  const page = webURL(before.pageURL);
  if (!page || before.origin !== page.origin || page.origin !== new URL(first.workerURL).origin) return false;
  return first.workerId === current.workerId && first.workerURL === current.workerURL && first.moduleURL === current.moduleURL
    && candidate.capture === before.capture && candidate.origin === before.origin && candidate.pageURL === before.pageURL
    && candidate.pid === before.pid && candidate.parentPid === before.parentPid && candidate.processGeneration === before.processGeneration;
}
