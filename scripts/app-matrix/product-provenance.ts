export function guestProvenance(receipt: string, artifact: { sha256: string; bytes: number }) {
  const fields = new Map<string, string>();
  for (const line of receipt.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error(`Duplicate guest receipt field: ${key}`);
    fields.set(key, line.slice(separator + 1));
  }
  const required = (key: string): string => {
    const value = fields.get(key);
    if (!value) throw new Error(`Guest receipt missing ${key}`);
    return value;
  };
  const sourceCommit = required("source_commit");
  const sourceTree = required("source_tree");
  const digest = required("guest_sha256");
  const bytes = Number(required("guest_bytes"));
  if (!/^[0-9a-f]{40}$/.test(sourceCommit) || !/^[0-9a-f]{40}$/.test(sourceTree)) throw new Error("Invalid guest source commit or tree");
  if (!/^[0-9a-f]{64}$/.test(digest) || digest !== artifact.sha256 || bytes !== artifact.bytes) throw new Error("Guest receipt does not match the executed artifact");
  return {
    source_commit: sourceCommit, source_tree: sourceTree, artifact_sha256: digest, artifact_bytes: bytes,
    built_at: required("date"), features: required("features"), target: required("target"),
    source_state_at_build: fields.get("guest_source_state") ?? "not recorded",
  };
}
