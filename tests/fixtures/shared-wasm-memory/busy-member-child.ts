// A group member that never yields: it signals through a shared word, then spins in JavaScript
// with no host call. Only its engine's own stop poll can end it once it is terminated.
import { workerData } from 'node:worker_threads';

const { ready } = workerData as { ready: Int32Array };
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);
for (;;) {}
