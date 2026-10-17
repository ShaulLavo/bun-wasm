import fs from 'node:fs';
fs.mkdirSync('watched/nested', { recursive: true });
fs.writeFileSync('watched/nested/file.txt', 'before');
const watcher = fs.watch('watched', { recursive: true }, (event, filename) => {
  if (filename !== 'nested/file.txt') return;
  console.log(event, filename);
  watcher.close();
});
watcher.once('close', () => console.log('closed'));
setTimeout(() => fs.writeFileSync('watched/nested/file.txt', 'after'), 20);
setTimeout(() => { throw new Error('watch notification missing'); }, 1500).unref();
