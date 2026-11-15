import { writeFile } from "node:fs/promises";
import { StoragePreservationFailure, storageReportPath } from "../sandbox/tests/storage-browser";

export async function reportStorageFailure(browser: string, error: unknown, env = process.env): Promise<never> {
  if (!(error instanceof StoragePreservationFailure)) throw error;
  const base = storageReportPath(env);
  if (base) await writeFile(`${base.replace(/\.json$/, "")}-${browser}-preservation.json`, JSON.stringify({ browser, ...error.report }, null, 2));
  throw error;
}
