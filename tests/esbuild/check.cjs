const assert = require('node:assert/strict');
const { writeFileSync, readFileSync } = require('node:fs');
const esbuild = require('esbuild');

(async () => {
  try {
    const transformed = await esbuild.transform('export const message: string = "日本語";', { loader: 'ts', format: 'esm', charset: 'utf8', sourcemap: 'external', sourcefile: 'unicode.ts' });
    assert.match(transformed.code, /日本語/);
    assert.doesNotMatch(transformed.code, /: string/);
    assert.match(JSON.parse(transformed.map).sourcesContent[0], /日本語/);
    await assert.rejects(esbuild.transform('const =', { loader: 'ts' }), /Transform failed/);
    writeFileSync('value.ts', 'export const value: number = 42;');
    writeFileSync('entry.ts', 'import { value } from "./value.ts"; console.log(value);');
    const built = await esbuild.build({ entryPoints: ['entry.ts'], bundle: true, write: false, metafile: true });
    assert.equal(built.outputFiles.length, 1);
    assert.match(built.outputFiles[0].text, /42/);
    assert.ok(built.metafile.inputs['value.ts']);
    const context = await esbuild.context({ entryPoints: ['entry.ts'], bundle: true, outfile: 'context.js' });
    try {
      await context.rebuild();
      assert.match(readFileSync('context.js', 'utf8'), /42/);
      writeFileSync('value.ts', 'export const value: number = 43;');
      await context.rebuild();
      assert.match(readFileSync('context.js', 'utf8'), /43/);
    } finally { await context.dispose(); }
    const pluginBuild = await esbuild.build({
      entryPoints: ['virtual:entry'], bundle: true, write: false,
      plugins: [{ name: 'fixture', setup(build) {
        build.onResolve({ filter: /^virtual:/ }, args => ({ path: args.path, namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, async () => ({ contents: 'export default 123;' }));
      } }],
    });
    assert.match(pluginBuild.outputFiles[0].text, /123/);
    console.log('esbuild API passed');
  } finally { await esbuild.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
