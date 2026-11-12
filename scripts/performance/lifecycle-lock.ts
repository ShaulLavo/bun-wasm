import { array, canonical, object, sha256 } from "./input";

function resolution(text: string) {
  const lock = object(Bun.JSON5.parse(text));
  const packages = object(lock.packages);
  const resolved = Object.fromEntries(Object.entries(packages).map(([name, entry]) => {
    const fields = array(entry);
    return [name, { resolution: fields[0], registry: fields[1], integrity: fields[3] }];
  }));
  return { workspaces: lock.workspaces, overrides: lock.overrides ?? null, packages: resolved };
}
export function verifyResolution(native: string, guest: string) {
  if (canonical(resolution(native)) !== canonical(resolution(guest))) throw new Error("Guest install changed frozen package resolutions or integrity");
  return { nativeSha256: sha256(native), guestSha256: sha256(guest), resolutionSha256: sha256(canonical(resolution(native))),
    sameResolution: true, metadataBytesEqual: native === guest };
}
