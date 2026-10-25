import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { checkPayload, payload } from "./payload.ts";

assert.ok(parentPort);
const port = parentPort;
const message = new Promise<ReturnType<typeof payload>>((resolve) => port.once("message", resolve));
await checkPayload(workerData);
const value = await message;
await checkPayload(value);
port.postMessage(value);
port.close();
