import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeGuest, type GuestDescriptor } from "./guest-artifact.ts";

const artifacts = ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"] as const;

/** Publication tests all three freshly built engines, including the exact guest
 * being uploaded. A missing sibling is a hard failure here, never a skipped gate. */
export async function verifyPublicationInputs(dist: string, descriptor: GuestDescriptor): Promise<void> {
  const missing: string[] = [];
  for (const name of artifacts) {
    const path = join(dist, name);
    const metadata = await stat(path).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!metadata?.isFile() || metadata.size === 0) missing.push(path);
  }
  if (missing.length) throw new Error(`Guest publication requires the full interruption matrix; missing: ${missing.join(", ")}`);
  for (const name of artifacts) {
    const candidate = describeGuest(await readFile(join(dist, name)));
    if (candidate.sha256 === descriptor.sha256 && candidate.bytes === descriptor.bytes) return;
  }
  throw new Error("Guest publication integrity mismatch: upload is not one of the tested matrix artifacts");
}

export async function acceptGuestPublication(dist: string, descriptor: GuestDescriptor, signal: AbortSignal): Promise<void> {
  await verifyPublicationInputs(dist, descriptor);
  signal.throwIfAborted();
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(web, "tests/browser-engine-interruption.ts"), "chromium", "firefox", "webkit"], {
      cwd: web, env: { ...process.env, BUN_WASM_INTERRUPTION_DIST: dist }, stdio: "inherit",
    });
    // The runner owns browser/profile/listener teardown. Signal it normally and
    // await close before publication can release resources or report failure.
    const abort = () => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let failure: Error | undefined;
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(new Error(`Guest publication interruption gate failed (${code})`));
      resolve();
    });
  });
  signal.throwIfAborted();
  // Refuse publication if the selected bytes changed while browsers were testing.
  await verifyPublicationInputs(dist, descriptor);
}
