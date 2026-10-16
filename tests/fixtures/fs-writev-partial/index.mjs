import fs from 'node:fs';
import assert from 'node:assert/strict';
const vectors = [Buffer.alloc(700, 65), Buffer.alloc(700, 66)];
const bytes = Buffer.concat(vectors);
function callbackWrite(fd, position) {
  return new Promise((resolve, reject) => fs.writev(fd, vectors, position, (error, count, buffers) =>
    error ? reject(Object.assign(error, { reportedBytes: count })) : resolve({ bytesWritten: count, buffers })));
}
async function scenario(mode, position, name) {
  const handle = mode === 'handle' ? await fs.promises.open(name, 'w+') : null;
  const fd = handle ? handle.fd : fs.openSync(name, 'w+');
  try {
    if (position !== null) fs.writeSync(fd, '_');
    const result = mode === 'sync' ? { bytesWritten: fs.writevSync(fd, vectors, position) }
      : mode === 'callback' ? await callbackWrite(fd, position) : await handle.writev(vectors, position);
    const expected = 1024 - (position || 0);
    assert.equal(result.bytesWritten, expected);
    if (mode !== 'sync') assert.equal(result.buffers, vectors);
    const contents = fs.readFileSync(name);
    assert.equal(contents.length, 1024);
    assert(contents.subarray(position || 0).equals(bytes.subarray(0, expected)));
    if (position === null) assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, null), 0);
    if (position !== null) {
      fs.writeSync(fd, '!');
      assert.equal(fs.readFileSync(name)[1], 33);
    }
    console.log(mode, position === null ? 'current' : position, result.bytesWritten);
  } finally {
    if (handle) await handle.close();
    else fs.closeSync(fd);
  }
}
let failed = false;
for (const mode of ['sync', 'callback', 'handle']) {
  for (const position of [null, 0, 500]) {
    const name = mode + '-' + position + '.txt';
    try { await scenario(mode, position, name); }
    catch (error) {
      failed = true;
      console.error('FAIL', mode, position, error.code || error.name, 'reported', error.reportedBytes, 'size', fs.statSync(name).size);
    }
  }
}
if (failed) throw new Error('writev partial-write cases failed');
