import fs from 'node:fs';
fs.writeFileSync('stable.txt', 'stable');
const watcher = fs.watch('stable.txt', () => { throw new Error('unchanged file emitted a change'); });
const reader = setInterval(() => { fs.statSync('stable.txt'); fs.readFileSync('stable.txt'); }, 20);
watcher.on('close', () => {
  clearInterval(reader);
  console.log('unchanged file stayed quiet');
  const controller = new AbortController();
  const aborted = fs.watch('stable.txt', { signal: controller.signal });
  aborted.on('close', () => {
    console.log('aborted');
    fs.watch('stable.txt').unref();
    console.log('unref does not keep the process alive');
  });
  controller.abort();
});
setTimeout(() => watcher.close(), 250);
