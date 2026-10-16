import { Stream, Readable, Writable } from 'node:stream';
import { inherits } from 'node:util';
import assert from 'node:assert/strict';
function LegacyStream() { Stream.call(this); }
inherits(LegacyStream, Stream);
const legacy = new LegacyStream();
legacy.on('value', (value) => console.log(value));
legacy.emit('value', 'legacy Stream initialized');
assert(legacy instanceof Stream);
const output = [];
const writable = new Writable({ write(chunk, encoding, done) { output.push(String(chunk)); done(); } });
const readable = new Readable({ read() { this.push('ok'); this.push(null); } });
readable.pipe(writable);
writable.on('finish', () => console.log(output.join('')));
