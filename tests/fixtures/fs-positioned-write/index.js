import { openSync, writeSync, closeSync, readFileSync } from 'node:fs';
const fd = openSync('positioned.txt', 'w+');
writeSync(fd, 'ABCD');
writeSync(fd, 'xy', 0);
writeSync(fd, '!');
closeSync(fd);
console.log(readFileSync('positioned.txt', 'utf8'));
