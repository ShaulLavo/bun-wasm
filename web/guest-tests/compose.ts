import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 90000 });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error: code ? stderr : "" }).toEqual({ code: 0, error: "" });
    return stdout;
  } finally { child.kill(); }
}

export function testCompose(artifact: "bun.wasm" | "bun-jsc.wasm" | "bun-browser.wasm") {
  test(`Node runtime_proc and local registry fetch compose for ${artifact}`, async () => {
    const code = `const {Worker}=require('node:worker_threads');
      const envs=[{PATH:'/does-not-contain-bun'}, {PATH:process.execPath.includes('/jsc/')?'/opt/bun/quickjs/bin':'/opt/bun/jsc/bin'}];
      for(const env of envs){
        const w=new Worker("require('node:worker_threads').parentPort.postMessage(process.execPath)",{eval:true,env});
        await new Promise((resolve,reject)=>{w.once('message',path=>{
          if(path!==process.execPath)reject(Error('worker engine '+path+' != '+process.execPath));
          else console.log('worker engine',path);
        });w.once('error',reject);w.once('exit',code=>code===0?resolve():reject(Error('worker exit '+code)));});
      }`;

    const output = await run(["node", "--no-warnings", "web/scripts/node-host.mjs", "--wasm", `dist/${artifact}`, "--", "-e", code]);
    expect(output.match(/worker engine /g)).toHaveLength(2);
    const identity = await run(["node", "--no-warnings", "web/scripts/node-host.mjs", "--wasm", `dist/${artifact}`,
      "--dir", `${root}/tests/fixtures/spawn-executable::/`, "--env", "PWD=/", "--", "run", "/index.ts"]);
    expect(identity).toContain("absolute self-spawn, fork and Worker preserve the admitted executable without PATH");
    const tools = await run(["node", "--no-warnings", "web/scripts/node-host.mjs", "--wasm", `dist/${artifact}`, "--", "-e",
      `const child=Bun.spawnSync([process.execPath,'lint','--rules','-f','json'],{env:{PATH:'/no-bun'},stdout:'pipe',stderr:'pipe'});if(child.exitCode!==0)throw Error(child.stderr.toString());if(JSON.parse(child.stdout.toString()).length<1000)throw Error('missing rules');console.log('child lint routed');`]);
    expect(tools).toContain("child lint routed");
    const installed = await run(["node", "tests/install/run.mjs"], {
      ...process.env, INSTALL_ENGINE: "browser", BUN_WASM: `dist/${artifact}`, INSTALL_CASES: "aliases",
    });
    expect(installed).toContain("1 passed, 0 failed");
  }, 120000);
}
