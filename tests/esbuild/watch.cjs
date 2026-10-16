const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');

async function until(predicate, label) {
  const deadline = Date.now() + 15000;
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
    await until(() => builds > 0, 'initial watch onEnd did not fire');
    assert.match(fs.readFileSync('watch-output.js', 'utf8'), /401/);
    fs.writeFileSync('watch-entry.ts', 'console.log(402)');
    await until(() => builds > 1 && fs.readFileSync('watch-output.js', 'utf8').includes('402'), 'watch did not receive file edit without stdin traffic');
    assert.deepEqual(errors, []);
    console.log('esbuild watch edit without stdin passed');
  } finally {
    await context?.dispose();
    await esbuild.stop();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
