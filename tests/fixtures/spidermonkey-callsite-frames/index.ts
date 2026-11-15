import assert from "node:assert/strict";
import { Script } from "node:vm";

const prepare = Error.prepareStackTrace;
const files = ["/literal%00%25-雪.ts", "/literal%2525.ts"];
function checkSourceURL(program: string, file: string) {
  let calls = 0;
  const error: unknown = new Script(program, { filename: "/compiler\0%00.ts" }).runInThisContext();
  assert(error instanceof Error);
  Error.prepareStackTrace = function (target, sites) {
    calls++;
    assert.equal(this, Error);
    assert.equal(target, error);
    assert(sites.some(site => site.getFileName() === file));
    assert(sites.every(site => site.getFileName() !== "self-hosted"));
    return sites;
  };
  assert.equal(calls, 0);
  const sites = error.stack;
  assert.equal(error.stack, sites);
  assert.equal(calls, 1);
  Error.prepareStackTrace = prepare;
}

try {
  for (const file of files) {
    const source = `new Error("sourceURL")\n//# sourceURL=${file}`;
    const programs = [source, `eval(${JSON.stringify(source)})`, `new Function(${JSON.stringify(`return ${source}`)})()`];
    for (const program of programs) checkSourceURL(program, file);
  }
  const holder: { stack?: unknown } = {};
  Error.captureStackTrace(holder);
  let calls = 0;
  Error.prepareStackTrace = (target, sites) => {
    calls++;
    assert.equal(target, holder);
    assert(sites.some(site => site.getFileName() === "/index.ts"));
    return sites;
  };
  assert.equal(calls, 0);
  const sites = holder.stack;
  assert.equal(holder.stack, sites);
  assert.equal(calls, 1);
} finally {
  Error.prepareStackTrace = prepare;
}
console.log("SpiderMonkey custom CallSites preserve sourceURL text and lazy identities");
