export interface WorkerReviewCase {
  name: string;
  code: string;
  exit: number;
  output: string[];
  error?: string;
  timeout?: number;
}

const start = `const { Worker, MessageChannel } = require('node:worker_threads');
const assert = require('node:assert/strict');`;
const memory = `const wasmModule = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0]));
const memory = new WebAssembly.Instance(wasmModule).exports.memory;`;

const unhandled: WorkerReviewCase[] = [
  {
    name: "unhandled-error", exit: 1, output: ["parent-exit 1"], error: "worker broke",
    code: `${start}
process.on('exit', code => console.log('parent-exit', code));
new Worker("throw new Error('worker broke')", {eval:true, stderr:true});`,
  },
];

export const workerReviewCases = unhandled.concat(["online", "error", "message", "exit"].map(event => ({
    name: `throwing-${event}-listener`, exit: 0, output: [`uncaught ${event} listener`, "parent-exit 0"],
    code: `${start}
process.on('uncaughtException', error => console.log('uncaught', error.message));
process.on('exit', code => console.log('parent-exit', code));
const w = new Worker(${JSON.stringify(event === "error" ? "throw new Error('child error')" : "require('node:worker_threads').parentPort.postMessage(1)")}, {eval:true, stderr:true});
w.on('messageerror', () => assert.fail('listener exception became messageerror'));
w.on('${event}', () => { throw new Error('${event} listener'); });`,
  })),
[false, true].map(handler => ({
    name: handler ? "exit-handler-backpressure" : "explicit-exit-backpressure", exit: 0,
    output: ["message 2000000", "exit 0"],
    code: `${start}
const payload = "const x = new Uint8Array(2000000); x[0] = 42; x[x.length-1] = 99; require('node:worker_threads').parentPort.postMessage(x);";
const w = new Worker(${handler ? `"process.on('exit', () => {" + payload + "})"` : `payload + "process.exit(0)"`}, {eval:true});
let messages = 0;
w.on('message', value => { assert.equal(value.length, 2000000); assert.equal(value[0], 42); assert.equal(value[value.length-1], 99); messages++; console.log('message', value.length); });
w.on('messageerror', error => { throw error; });
w.on('exit', code => { assert.equal(messages, 1); assert.equal(code, 0); console.log('exit', code); });
const until = Date.now() + 500; while (Date.now() < until) {}`,
  })),
  [{
    name: "atomic-transfer", exit: 0, output: ["atomic transfer attached", "constructor failures reclaimed"],
    code: `${start}
${memory}
const w = new Worker("require('node:worker_threads').parentPort.on('message', () => {})", {eval:true});
const a = new ArrayBuffer(4); const b = memory.buffer;
const {port1, port2} = new MessageChannel();
assert.throws(() => w.postMessage({a,b,port1}, [a,b,port1]), {name:'DataCloneError'});
assert.equal(a.byteLength, 4); assert.equal(b.byteLength, 65536);
port1.postMessage('still attached');
port2.once('message', value => { assert.equal(value, 'still attached'); port1.close(); port2.close(); });
console.log('atomic transfer attached');
w.terminate().then(async () => {
  for (let i = 0; i < 8; i++) {
    const a = new ArrayBuffer(4);
    assert.throws(() => new Worker("require('node:worker_threads').parentPort.on('message', () => {})", {eval:true,workerData:{a,b},transferList:[a,b]}), {name:'DataCloneError'});
    assert.equal(a.byteLength, 4);
  }
  const healthy = new Worker('', {eval:true});
  healthy.on('exit', code => { assert.equal(code, 0); console.log('constructor failures reclaimed'); });
});`,
  }, {
    name: "clone-atomic-transfer", exit: 0, output: ["clone transfer attached"],
    code: `${start}
${memory}
const a = new ArrayBuffer(4); const b = memory.buffer;
assert.throws(() => structuredClone({a,b}, {transfer:[a,b]}), {name:'DataCloneError'});
assert.equal(a.byteLength, 4); assert.equal(b.byteLength, 65536);
console.log('clone transfer attached');`,
  }, {
    name: "constructor-rollback", exit: 0, timeout: 10000, output: ["failed constructor reaped"],
    code: `${start}
${memory}
const a = new ArrayBuffer(4); const b = memory.buffer;
let failure;
try { new Worker("require('node:worker_threads').parentPort.on('message', () => {})", {eval:true,workerData:{a,b},transferList:[a,b]}); }
catch (error) { failure = error; }
process.on('exit', () => { assert.equal(failure?.name, 'DataCloneError'); assert.equal(a.byteLength, 4); console.log('failed constructor reaped'); });`,
  }],
[false, true].map(online => ({
    name: online ? "unref-terminate-online" : "unref-terminate-startup", exit: 0,
    output: ["exit once", "termination settled"],
    code: `${start}
const w = new Worker('setInterval(() => {}, 1000)', {eval:true});
let exits = 0;
w.on('exit', code => { assert.ok(code === 0 || code === 1); exits++; console.log('exit once'); });
function terminate() { w.unref(); w.terminate().then(code => { assert.ok(code === 0 || code === 1); assert.equal(exits, 1); console.log('termination settled'); }); }
${online ? "w.once('online', terminate);" : "terminate();"}`,
  })),
["stdout", "stderr"].map(stream => ({
    name: `drained-${stream}`, exit: 0, output: [`${stream} 73400320 exit 0`],
    code: `${start}
const w = new Worker("const x='x'.repeat(1048576); for (let i=0; i<70; i++) process.${stream}.write(x)", {eval:true,stdout:true,stderr:true});
let bytes = 0;
w.${stream}.on('data', chunk => bytes += chunk.length);
w.on('exit', code => { assert.equal(code, 0); assert.equal(bytes, 73400320); console.log('${stream}', bytes, 'exit', code); });`,
  })),
[0, 7].map(code => ({
    name: `terminate-after-exit-${code}`, exit: 0, output: [`exit ${code} terminate undefined once`],
    code: `${start}
const w = new Worker('process.exit(${code})', {eval:true});
let exits = 0;
w.on('exit', async code => { exits++; assert.equal(code, ${code}); assert.equal(await w.terminate(), undefined); assert.equal(await w.terminate(), undefined); assert.equal(exits, 1); console.log('exit', code, 'terminate undefined once'); });`,
  })),
);
