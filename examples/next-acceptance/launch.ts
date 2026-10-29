import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

process.env.NEXT_TELEMETRY_DISABLED = "1";
process.argv[1] = resolve("node_modules/next/dist/bin/next");
await import(pathToFileURL(process.argv[1]).href);
