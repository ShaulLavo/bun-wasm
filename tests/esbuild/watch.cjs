const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
let stdinWrites = 0;
let edited = false;
let writesAtNotification;
let notification = '';
let resumeStdin = () => {};
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args);
  const write = child.stdin.write;
  const queued = [];
  resumeStdin = () => {
    for (const pending of queued.splice(0)) { stdinWrites++; write.apply(child.stdin, pending); }
  };
  child.stdout.on('data', chunk => {
    if (!edited || writesAtNotification !== undefined) return;
    notification += chunk.toString('utf8');
    if (/on-(start|end)/.test(notification)) {
      writesAtNotification = stdinWrites;
      resumeStdin();
    }
    notification = notification.slice(-128);
  });
  child.stdin.write = function (...args) {
    if (edited && writesAtNotification === undefined) { queued.push(args); return true; }
    stdinWrites++;
    return write.apply(this, args);
  };
  return child;
};
const esbuild = require('esbuild');

async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

(async () => {
  let context;
  let builds = 0;
  const errors = [];
  try {
    fs.writeFileSync('watch-entry.ts', 'console.log(401)');
    context = await esbuild.context({
      entryPoints: ['watch-entry.ts'], bundle: true, outfile: 'watch-output.js',
      plugins: [{ name: 'watch-fixture', setup(build) {
        build.onEnd(result => { builds++; errors.push(...result.errors); });
      } }],
    });
    await context.watch();
    await until(() => builds > 0, 'initial watch onEnd did not fire', 60000);
    assert.match(fs.readFileSync('watch-output.js', 'utf8'), /401/);
    await new Promise(resolve => setTimeout(resolve, 500));
    const requestsAtEdit = stdinWrites;
    edited = true;
    fs.writeFileSync('watch-entry.ts', 'console.log(402)');
    await until(() => builds > 1 && fs.readFileSync('watch-output.js', 'utf8').includes('402'), 'watch did not receive file edit without stdin traffic');
    assert.equal(writesAtNotification, requestsAtEdit, 'watch notification required stdin traffic after the edit');
    assert.deepEqual(errors, []);
    console.log('esbuild watch edit without stdin passed');
  } finally {
    edited = false;
    resumeStdin();
    await context?.dispose();
    await esbuild.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
