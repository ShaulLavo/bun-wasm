import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ ok: true, bunOptions: process.env.BUN_OPTIONS ?? null });
