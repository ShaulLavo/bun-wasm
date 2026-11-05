// Runs one row in a fresh guest process and prints `IORC_ROW <json>`. The process must then exit
// by itself: a resource left referenced keeps it alive, and the orchestrator reports it as hung.
import { AsyncLocalStorage } from "node:async_hooks";
import { isRowId, type Observation, type Value } from "./rows.ts";
import { routeServer, scenarios, type Context } from "./scenarios.ts";

const WAIT_MS = 8000;
const id = process.argv[2] ?? "";
if (!isRowId(id)) throw new Error(`unknown io-resource-context row: ${id}`);

const storage = new AsyncLocalStorage<string>();
const records: Observation[] = [];
let armed: boolean | undefined;
const see = (site: string, ...values: Value[]) => {
  const record: Observation = [site, storage.getStore() ?? null, ...values];
  records.push(record);
  console.log(`IORC_EVENT ${JSON.stringify({ id, record })}`);
};
const count = (site: string) => records.filter(record => record[0] === site).length;

async function until(site: string, wanted = 1): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (count(site) < wanted && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
}

// Registered before any frame exists; everything after runs with an unrelated ambient store, so a
// callback that kept the turn's frame is distinguishable from one that ran in its resource's.
const early = id === "serve.root-registration" ? routeServer(see) : undefined;
storage.enterWith("unrelated");

const context: Context = {
  storage, early, see, count, until,
  mark: marker => console.log(marker),
  arm: value => { armed = value; },
};
let error: string | null = null;
let settled = 0;
process.once("exit", () => {
  console.log(`IORC_ROW ${JSON.stringify({ id, records, settled, armed: armed ?? null, error, execPath: process.execPath })}`);
});
try {
  await scenarios[id](context);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  process.exitCode = 1;
}
settled = records.length;
console.log(`IORC_SETTLED ${JSON.stringify({ id, count: settled })}`);
