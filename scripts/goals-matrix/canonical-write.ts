import { spawn } from "node:child_process";
import { join } from "node:path";
import { stat } from "node:fs/promises";

export const publicationMarker = ".campaign-policy-publication.json";
export async function assertNoPublication(directory: string): Promise<void> {
  try { await stat(join(directory, publicationMarker)); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Recover the unfinished campaign policy publication before canonical writes");
}

export async function withCanonicalWriter<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  // util-linux supplies flock on the canonical Linux host; it is not an npm dependency.
  const child = spawn("flock", ["--exclusive", join(directory, ".canonical-writer.lock"), "sh", "-c", "printf 'locked\\n'; IFS= read -r release || :"], { stdio: "pipe" });
  const ready = Promise.withResolvers<void>();
  let output = "", errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output === "locked\n") ready.resolve();
    else if (output.includes("\n")) ready.reject(new Error("Invalid canonical writer lock response"));
  });
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  try {
    await Promise.race([ready.promise, exited.then(code => { throw new Error(`Canonical writer lock exited ${code}: ${errors}`); })]);
    return await operation();
  } finally {
    child.stdin.end();
    await exited;
  }
}
