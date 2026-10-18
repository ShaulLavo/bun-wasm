import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";

assert.ok(process.execPath.startsWith("/"), `execPath is not absolute: ${process.execPath}`);
const environments = [{ PATH: "/no-bun-here" }, { PATH: process.execPath.includes("/jsc/") ? "/opt/bun/quickjs/bin" : "/opt/bun/jsc/bin" }];
for (const env of environments) {
  const child = Bun.spawn([process.execPath, "-e", "console.log(process.execPath)"], { env, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text();
  assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  assert.equal((await output).trim(), process.execPath);

  const forked = fork(new URL("./child.ts", import.meta.url).pathname, [], { env, silent: true });
  let forkOutput = "", forkError = "";
  forked.stdout!.on("data", chunk => { forkOutput += chunk; });
  forked.stderr!.on("data", chunk => { forkError += chunk; });
  assert.equal(await new Promise((resolve, reject) => { forked.once("error", reject); forked.once("close", resolve); }), 0, forkError);
  assert.equal(forkOutput.trim(), process.execPath);

  const worker = new Worker("require('node:worker_threads').parentPort.postMessage(process.execPath)", { eval: true, env });
  let workerPath: unknown;
  worker.once("message", path => { workerPath = path; });
  assert.equal(await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); }), 0);
  assert.equal(workerPath, process.execPath);
}
const bin = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
const canonicalChild = `
  const expected=${JSON.stringify(process.execPath)};
  if(process.execPath!==expected)throw Error('noncanonical executable '+process.execPath);
  process.chdir('/');
  const child=Bun.spawnSync([process.execPath,'-e','console.log(process.execPath)'],{env:{PATH:'/no-bun'},stdout:'pipe',stderr:'pipe'});
  if(child.exitCode!==0||child.stdout.toString().trim()!==expected)throw Error('self-spawn after chdir '+child.stderr.toString());
  const worker=new (require('node:worker_threads').Worker)("require('node:worker_threads').parentPort.postMessage(process.execPath)",{eval:true,env:{PATH:'/no-bun'}});
  let path;worker.once('message',value=>{path=value});
  await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('worker after chdir '+code)))});
  if(path!==expected)throw Error('worker executable after chdir '+path);
  console.log(process.execPath);
`;
for (const executable of ["./bun", "../bin/bun"]) {
  const child = Bun.spawn([executable, "-e", canonicalChild], { cwd: bin, env: { PATH: "/no-bun" }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text();
  assert.equal(await child.exited, 0, await new Response(child.stderr).text());
  assert.equal((await output).trim(), process.execPath);
}
console.log("absolute self-spawn, fork and Worker preserve the admitted executable without PATH");
