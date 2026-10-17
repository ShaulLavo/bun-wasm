import assert from 'node:assert/strict';
import fs from 'node:fs';
fs.writeFileSync('watched.txt', 'before');
for (const withOptions of [false, true]) {
  let calls = 0;
  const callback = function (this: fs.FSWatcher, event: string) {
    assert.equal(this, watcher);
    assert.equal(event, 'change');
    calls++;
  };
  const watcher = withOptions ? fs.watch('watched.txt', {}, callback) : fs.watch('watched.txt', callback);
  try {
    assert.equal(watcher.listenerCount('change'), 1);
    assert.equal(watcher.listeners('change')[0], callback);
    assert.equal(watcher.rawListeners('change')[0], callback);
    watcher.emit('change', 'change', 'watched.txt');
    assert.equal(calls, 1);
    watcher.off('change', callback);
    assert.equal(watcher.listenerCount('change'), 0);
    watcher.emit('change', 'change', 'watched.txt');
    assert.equal(calls, 1);
    watcher.once('change', callback);
    assert.equal(watcher.listeners('change')[0], callback);
    assert.equal(watcher.rawListeners('change')[0].listener, callback);
    assert.equal(watcher.listenerCount('change'), 1);
    watcher.removeListener('change', callback);
    assert.equal(watcher.listenerCount('change'), 0);
    watcher.once('change', callback);
    watcher.emit('change', 'change', 'watched.txt');
    watcher.emit('change', 'change', 'watched.txt');
    assert.equal(calls, 2);
    assert.equal(watcher.listenerCount('change'), 0);
    console.log(`${withOptions ? 'three' : 'two'} arguments preserve listener identity, once, off and counts`);
  } finally {
    watcher.close();
  }
}
