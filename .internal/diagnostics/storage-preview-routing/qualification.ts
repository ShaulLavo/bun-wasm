import assert from "node:assert/strict";
export type Row = Record<string, unknown>;
export function record(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function rows(value: unknown): Row[] {
  assert(Array.isArray(value) && value.every(record));
  return value;
}
export function qualify(input: { rows: Row[]; target: string; url: string; build: string; worker: Row; page: Row; response: Row }) {
  const { target, build, worker, page, response } = input;
  const all = input.rows;
  const select = (kind: string) => all.filter(row => row.kind === kind);
  assert.equal(response.status, 200); assert.equal(response.fromServiceWorker, true);
  assert(typeof response.body === "string" && response.body.includes("Hello from hono"));
  assert.equal(worker.build, build); assert.equal(worker.realm, "worker");
  assert(typeof worker.scope === "string" && worker.scope.endsWith("/sandbox/__preview/"));
  const forwards = select("forward").filter(row => row.target === target && row.generation === worker.generation);
  assert.equal(forwards.length, 1, "unique qualification target, no invented cross-realm port id");
  const forward = forwards[0]!;
  const claims = select("claim-reply").filter(row => row.ask === forward.ask && row.generation === worker.generation);
  assert(claims.some(row => row.reply === "accepted" && row.acceptedReceipt === true));
  assert(claims.some(row => row.reply === "head" && record(row.payload) && row.payload.status === 200));
  assert(select("sw-fetch").some(row => row.url === input.url && row.generation === worker.generation));
  assert(select("evaluated-generation").some(row => row.generation === worker.generation));
  assert(select("activated-generation").some(row => row.generation === worker.generation));
  const returned = select("request-return").filter(row => row.target === target && row.generation === page.generation);
  assert.equal(returned.length, 1); const handled = returned[0]!;
  assert.equal(handled.accepted, true); assert(typeof handled.current === "number");
  assert(select("runtime-router").some(row => row.router === handled.router && row.runtime === page.runtimeId && row.generation === page.generation));
  assert(select("sandbox-listening").some(row => row.router === handled.router && row.helper === handled.current && row.generation === page.generation));
  assert(select("register").some(row => row.router === handled.router && row.server === handled.current && row.generation === page.generation));
  const projection = select("helper-projection").find(row => row.capability === handled.current && row.generation === page.generation);
  assert(projection);
  assert(select("projection-request").some(row => row.capability === handled.current && row.helper === projection.helper && row.target === target && row.closed === false && row.generation === page.generation));
  assert(select("helper-request-return").some(row => row.helper === projection.helper && row.target === target && row.accepted === true && row.disposed === false && row.generation === page.generation));
  assert(select("helper-connect").some(row => row.helper === projection.helper && row.disposed === false && row.generation === page.generation));
  assert.equal(page.mainDocument, true); assert.equal(page.template, "hono");
  return { armed: true, target, build, workerGeneration: worker.generation, scope: worker.scope, pageGeneration: page.generation, router: handled.router, helper: handled.current,
    nativePortIdentityClaimed: false, crossRealmClockOrderClaimed: false, diagnosticScenarioPass: false };
}
