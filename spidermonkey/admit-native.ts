import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileHash, record } from "./native-profile.ts";
import { prepareEngineInputs } from "./prepare-engine-inputs.ts";

const [directory, destination] = process.argv.slice(2);
assert(directory && destination, "Usage: admit-native.ts CURRENT_BUILD_DIR NEW_NATIVE_DIRECTORY");
const root = resolve(directory);
execFileSync("node", [new URL("./check-build.ts", import.meta.url).pathname, root, "--verify"], { stdio: "inherit" });
const qualification = join(root, "receipt/vm-library.json");
const receipt: unknown = JSON.parse(readFileSync(qualification, "utf8"));
assert(record(receipt) && record(receipt.source) && record(receipt.headers));
const archive = join(root, "libspidermonkey_bunwasm.a");
const admission = {
  status: "ADMITTED_CURRENT_NATIVE_GENERATION", admitted: true,
  compiledSource: { head: receipt.source.commit, tree: receipt.source.tree },
  archive: { path: archive, bytes: statSync(archive).size, sha256: fileHash(archive) },
  profile: { path: join(root, "receipt/native-profile.json"), sha256: fileHash(join(root, "receipt/native-profile.json")) },
  qualification: { path: qualification, sha256: fileHash(qualification) },
  headers: { includeRoot: join(root, "obj/dist/include"), manifest: join(root, "receipt/headers.json"),
    manifestSha256: receipt.headers.sha256, count: receipt.headers.count,
    confdefs: join(root, "obj/js/src/js-confdefs.h"), confdefsSha256: receipt.confdefsSha256 },
};
const path = join(root, "receipt/current-admission.json");
writeFileSync(path, JSON.stringify(admission, null, 2) + "\n", { flag: "wx" });
prepareEngineInputs(path, resolve(destination));
