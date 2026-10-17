import fs from 'node:fs';
fs.writeFileSync('watched.txt', 'before');
const callback = () => { throw new Error('removed callback fired'); };
const watcher = fs.watch('watched.txt', callback);
console.log(`listener property ${watcher.rawListeners('change')[0]?.listener === callback}`);
watcher.removeListener('change', callback);
console.log(`listeners ${watcher.listenerCount('change')}`);
watcher.close();
