import * as fs from "node:fs";
import { join } from "node:path";
import { verifyFilesystemStreams } from "./contract.ts";

const root = fs.mkdtempSync(join(process.cwd(), "fs-streams-"));
try {
  await verifyFilesystemStreams(fs, root);
  console.log("fs stream constructors, inheritance, data, errors and cleanup");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
