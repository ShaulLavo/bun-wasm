import { createRequire } from 'node:module';
import WS from 'ws';
const require = createRequire(import.meta.url);
console.log(require('ws') === WS);
console.log(import.meta.require('ws').WebSocketServer === WS.WebSocketServer);
console.log(require.resolve('ws'));
console.log(require.resolve.paths('ws'));
