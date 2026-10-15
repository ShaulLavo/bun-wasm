import fs from 'node:fs';
import assert from 'node:assert/strict';
const fd = fs.openSync('vector.txt', 'w+');
const bytes = new Uint8Array([88, 65, 66, 89]);
const vectors = [bytes.subarray(1, 3), new DataView(new Uint8Array([67, 68]).buffer)];
console.log(fs.writevSync(fd, vectors), fs.writevSync(fd, []));
let returned = false;
await new Promise((resolve, reject) => {
  fs.writev(fd, [Buffer.from('xy'), Buffer.from('z')], 1, (error, count, buffers) => {
    if (error) return reject(error);
    assert(returned);
    console.log(count, buffers.length);
    resolve();
  });
  returned = true;
});
fs.writeSync(fd, '!');
fs.closeSync(fd);
console.log(fs.readFileSync('vector.txt', 'utf8'));
const file = await fs.promises.open('vector.txt', 'r+');
const buffers = [Buffer.from('12'), Buffer.from('3')];
const result = await file.writev(buffers, 0);
console.log(result.bytesWritten, result.buffers === buffers);
await file.close();
console.log(fs.readFileSync('vector.txt', 'utf8'));
for (const invalid of [null, ['text'], [{}]]) {
  assert.throws(() => fs.writevSync(1, invalid), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => fs.writev(1, invalid, () => {}), { code: 'ERR_INVALID_ARG_TYPE' });
}
console.log('invalid vectors rejected');
