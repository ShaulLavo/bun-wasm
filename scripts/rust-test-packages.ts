/** Path-patched crates whose local changes carry tests. They are not workspace members. */
const patchedTestPackages = ["wasmi_core"] as const;

interface Metadata {
  packages: { id: string; name: string }[];
  workspace_members: string[];
}

/**
 * `cargo test` package arguments for every workspace member plus the patched crates, in one
 * invocation. `--workspace` cannot be combined with them: Cargo then accepts `-p` only for
 * members and rejects `wasmi_core`.
 */
export function rustTestPackages(metadata: Metadata): string[] {
  const members = new Set(metadata.workspace_members);
  const names = metadata.packages.filter(item => members.has(item.id)).map(item => item.name);
  if (names.length !== members.size) throw new Error("cargo metadata is missing workspace members");
  return names.toSorted().concat(patchedTestPackages).flatMap(name => ["-p", name]);
}
