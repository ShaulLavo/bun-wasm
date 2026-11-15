import { expect as playwrightExpect } from "playwright/test";

function endpoint(row: object) {
  if (!("snapshot" in row) || !row.snapshot || typeof row.snapshot !== "object") return;
  const snapshot = row.snapshot;
  if (!("documentId" in row) || typeof row.documentId !== "string" || !row.documentId) return;
  if (!("runtimeId" in row) || typeof row.runtimeId !== "string" || !row.runtimeId) return;
  if (!("workerId" in row) || !(row.workerId === null || positiveCount(row.workerId))) return;
  if (!("owner" in snapshot) || !positiveCount(snapshot.owner) || !("generation" in snapshot) || !positiveCount(snapshot.generation)) return;
  if (!("endpoint" in snapshot) || !("handlersQualified" in snapshot) || snapshot.handlersQualified !== true) return;
  return { documentId: row.documentId, runtimeId: row.runtimeId, owner: snapshot.owner, generation: snapshot.generation,
    endpoint: snapshot.endpoint, requestSends: "requestSends" in snapshot ? snapshot.requestSends : undefined,
    requestReceives: "requestReceives" in snapshot ? snapshot.requestReceives : undefined };
}

function positiveCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function matchesEntry(row: object, entry: string): boolean {
  if (!("process" in row) || !row.process || typeof row.process !== "object") return false;
  const process = row.process;
  if (!("entry" in process) || process.entry !== entry) return false;
  return entry !== "preview1" || ("executorBranch" in process && process.executorBranch === "terminal");
}

/** Real request traffic on one original qualified client and its exact service peer. */
export function hasEntryRequestTraffic(rows: readonly object[], entry: string): boolean {
  const peers = rows.map(endpoint);
  return rows.some(row => {
    if (!matchesEntry(row, entry)) return false;
    const client = endpoint(row);
    if (!client || client.endpoint !== "client" || !positiveCount(client.requestSends)) return false;
    return peers.some(peer => peer?.endpoint === "service" && positiveCount(peer.requestReceives)
      && peer.documentId === client.documentId && peer.runtimeId === client.runtimeId
      && peer.owner === client.owner && peer.generation === client.generation);
  });
}

export async function waitForEntryRequestTraffic(read: () => Promise<readonly object[]>, entry: string): Promise<readonly object[]> {
  let rows: readonly object[] = [];
  await playwrightExpect.poll(async () => {
    rows = await read();
    return hasEntryRequestTraffic(rows, entry);
  }, { timeout: 120_000 }).toBe(true);
  return rows;
}
