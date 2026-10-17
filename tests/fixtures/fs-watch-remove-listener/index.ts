import fs from 'node:fs';
fs.writeFileSync('watched.txt', 'before');
const callback = () => { throw new Error('removed callback fired'); };
const watcher = fs.watch('watched.txt', callback);
console.log(`raw listener ${watcher.rawListeners('change')[0] === callback}`);
watcher.removeListener('change', callback);
console.log(`listeners ${watcher.listenerCount('change')}`);
watcher.close();
