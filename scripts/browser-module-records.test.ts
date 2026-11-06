// Browser-guest check: the worker module loader in Chromium and WebKit, on the browser guest
// built from this checkout. The guest at dist/bun-browser.wasm must carry a receipt for this
// exact commit (CI links the rust job's verified `source-cache-browser` guest there, and the
// bash-web guests beside it). The web output is built from that guest here; its identities
// are recorded before and after the browsers run and must not change.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { guestBuilds } from "./guest-source-manifest";
import { verifyGuestBuildReceipt } from "./guest-build-receipt";

const root = resolve(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The served web output's identities: the guest raw and inside the gzip, its metadata, the host bundle. */
function webIdentity(guest: Uint8Array) {
  const web = join(root, "web/dist");
  const gzip = readFileSync(join(web, "bun-browser.wasm.gz"));
  const builds = JSON.parse(readFileSync(join(web, "engine-builds.json"), "utf8")) as Record<string, string>;
  return {
    guestSha256: sha256(guest),
    gzipSha256: sha256(gzip),
    gzipDecodedSha256: sha256(gunzipSync(gzip)),
    engineBuildsSha256: builds["bun-browser.wasm"],
    workerSha256: sha256(readFileSync(join(web, "worker.js"))),
    serviceWorkerSha256: sha256(readFileSync(join(web, "sw.js"))),
  };
}

test("worker ES module cycles load without a service-worker controller, on this checkout's guest", () => {
  const guestPath = join(root, "dist/bun-browser.wasm");
  const guest = readFileSync(guestPath);
  const receipt: unknown = JSON.parse(readFileSync(`${guestPath}.build.json`, "utf8"));
  verifyGuestBuildReceipt(guest, receipt);
  expect(guestBuilds[receipt.sourceManifest.build].artifact).toBe("bun-browser.wasm");
  const head = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  expect([receipt.sourceManifest.source.head, receipt.sourceManifest.source.tree]).toEqual(head);
  execFileSync(process.execPath, [join(root, "web/build.ts")], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const before = webIdentity(guest);
  expect([before.gzipDecodedSha256, before.engineBuildsSha256]).toEqual([before.guestSha256, before.guestSha256]);
  console.log(JSON.stringify({ source: head, build: receipt.sourceManifest.build, web: before }));
  const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
  execFileSync(process.execPath, ["tests/browser-module-records.ts"].concat(browsers), { cwd: join(root, "web"), stdio: "inherit" });
  expect(webIdentity(readFileSync(guestPath))).toEqual(before);
}, 900_000);
