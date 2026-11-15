/** Keep the latest complete endpoint history instead of spending the ring on its older snapshots. */
export function retainMetadata(rows: object[], row: object): boolean {
  const key = metadataKey(row);
  const previous = key === null ? -1 : rows.findIndex(value => metadataKey(value) === key);
  if (previous >= 0) rows.splice(previous, 1);
  rows.push(row);
  if (rows.length <= 32) return false;
  rows.shift();
  return true;
}

function metadataKey(row: object): string | null {
  const identity = "snapshot" in row ? row.snapshot : "serviceTransfer" in row ? row.serviceTransfer : null;
  if (!identity || typeof identity !== "object" || !("owner" in identity) || !("generation" in identity)) return null;
  return JSON.stringify([
    "documentId" in row ? row.documentId : null, "runtimeId" in row ? row.runtimeId : null,
    "workerId" in row ? row.workerId : null, "snapshot" in row ? "endpoint" : "service-transfer",
    "endpoint" in identity ? identity.endpoint : null, identity.owner, identity.generation,
  ]);
}
