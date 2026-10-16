const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const failures = [];

function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(`${name}: ${error.message}`); console.error(`${name}: ${error.stack}`); }
}

try {
  assert.equal(process.env.ESBUILD_WORKER_THREADS, undefined);
  check('transformSync', () => {
    const transformed = esbuild.transformSync('export const value: number = 47;', { loader: 'ts', format: 'esm' });
    assert.match(transformed.code, /47/);
    assert.doesNotMatch(transformed.code, /: number/);
  });
  check('buildSync', () => {
    const built = esbuild.buildSync({ stdin: { contents: 'console.log(48)' }, bundle: true, write: false, metafile: true });
    assert.match(built.outputFiles[0].text, /48/);
    assert.match(esbuild.analyzeMetafileSync(built.metafile), /stdin/);
  });
  check('analyzeMetafileSync', () => {
    assert.equal(typeof esbuild.analyzeMetafileSync({ inputs: {}, outputs: {} }), 'string');
  });
  check('formatMessagesSync', () => {
    assert.match(esbuild.formatMessagesSync([{ text: 'fixture error' }], { kind: 'error', color: false })[0], /fixture error/);
  });
  check('syntax error', () => {
    assert.throws(() => esbuild.transformSync('const =', { loader: 'ts', logLevel: 'silent' }), /Transform failed/);
  });
  check('synchronous plugin error', () => {
    assert.throws(() => esbuild.buildSync({ plugins: [{ name: 'sync-plugin', setup() {} }], logLevel: 'silent' }), /Cannot use plugins in synchronous API calls/);
  });
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log('esbuild synchronous APIs passed');
} finally { esbuild.stop(); }
