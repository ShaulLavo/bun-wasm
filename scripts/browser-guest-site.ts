// The playground site the browser-guest checks serve, built once from this checkout's browser
// guest and verified wherever it is used.
//
//   bun scripts/browser-guest-site.ts build <out>    from dist/bun-browser.wasm and its receipt
//   bun scripts/browser-guest-site.ts verify <out>   a site built or downloaded for this checkout
//
// `build` requires the guest's receipt to name this commit and tree, bundles the playground
// (web/build.ts) once, and writes `<out>/site/` (every served file) and `<out>/site.json`: the
// source, the receipt, and the sha256 of every served file. `verify` re-reads all of it: the
// site must hold exactly the listed files with those hashes, the gzipped guest must decode to
// the bytes the receipt names, `engine-builds.json` must name the same hash, and the receipt
// must name the checked-out commit. CI's rust job builds it; each browser leg only verifies it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { guestBuilds } from "./guest-source-manifest";
import { verifyGuestBuildReceipt, type GuestBuildReceipt } from "./guest-build-receipt";

const root = resolve(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface SiteIdentity {
  source: { head: string; tree: string };
  receipt: GuestBuildReceipt;
  guest: { sha256: string; bytes: number; gzipSha256: string };
  files: Record<string, string>;
}

function checkout(): { head: string; tree: string } {
  const [head, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  return { head: head!, tree: tree! };
}

/** sha256 of every file under `dir`, by `/`-separated relative path, sorted. */
function inventory(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at).sort()) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).split("\\").join("/")] = sha256(readFileSync(path));
    }
  };
  walk(dir);
  return files;
}

function verifiedReceipt(guest: Uint8Array, receipt: unknown, source: { head: string; tree: string }): GuestBuildReceipt {
  verifyGuestBuildReceipt(guest, receipt);
  if (guestBuilds[receipt.sourceManifest.build].artifact !== "bun-browser.wasm") throw new Error(`Not a browser guest build: ${receipt.sourceManifest.build}`);
  const named = receipt.sourceManifest.source;
  if (named.head !== source.head || named.tree !== source.tree) throw new Error(`Guest receipt names ${named.head}/${named.tree}, not this checkout ${source.head}/${source.tree}`);
  return receipt;
}

export function buildSite(out: string): SiteIdentity {
  const source = checkout();
  const guestPath = join(root, "dist/bun-browser.wasm");
  const guest = readFileSync(guestPath);
  const receipt = verifiedReceipt(guest, JSON.parse(readFileSync(`${guestPath}.build.json`, "utf8")), source);
  execFileSync(process.execPath, [join(root, "web/build.ts")], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, "web/dist"), join(out, "site"), { recursive: true });
  const identity: SiteIdentity = {
    source,
    receipt,
    guest: { sha256: sha256(guest), bytes: guest.byteLength, gzipSha256: sha256(readFileSync(join(out, "site/bun-browser.wasm.gz"))) },
    files: inventory(join(out, "site")),
  };
  writeFileSync(join(out, "site.json"), `${JSON.stringify(identity, null, 1)}\n`);
  return verifySite(out);
}

export function verifySite(out: string): SiteIdentity {
  const identity = JSON.parse(readFileSync(join(out, "site.json"), "utf8")) as SiteIdentity;
  const source = checkout();
  if (identity.source.head !== source.head || identity.source.tree !== source.tree) throw new Error(`Site built for ${identity.source.head}, not this checkout ${source.head}`);
  const site = join(out, "site");
  const files = inventory(site);
  const listed = Object.keys(identity.files);
  const extra = Object.keys(files).filter(path => !(path in identity.files));
  const changed = listed.filter(path => files[path] !== identity.files[path]);
  if (extra.length || changed.length) throw new Error(`Site differs from site.json: extra ${extra.join(", ") || "none"}; changed or missing ${changed.join(", ") || "none"}`);
  const gzip = readFileSync(join(site, "bun-browser.wasm.gz"));
  const guest = gunzipSync(gzip);
  const receipt = verifiedReceipt(guest, identity.receipt, source);
  const builds = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8")) as Record<string, string>;
  const guestSha256 = sha256(guest);
  if (guestSha256 !== identity.guest.sha256 || guest.byteLength !== identity.guest.bytes || sha256(gzip) !== identity.guest.gzipSha256) throw new Error("Site guest differs from site.json");
  if (builds["bun-browser.wasm"] !== guestSha256) throw new Error(`engine-builds.json names ${builds["bun-browser.wasm"]}, the site's guest is ${guestSha256}`);
  return { ...identity, receipt };
}

if (import.meta.main) {
  const [command, out] = process.argv.slice(2);
  if (!out || (command !== "build" && command !== "verify")) throw new Error("Usage: browser-guest-site.ts build|verify <out>");
  const identity = command === "build" ? buildSite(resolve(out)) : verifySite(resolve(out));
  console.log(JSON.stringify({ source: identity.source, guest: identity.guest, files: Object.keys(identity.files).length, inventorySha256: sha256(JSON.stringify(identity.files)) }));
}
