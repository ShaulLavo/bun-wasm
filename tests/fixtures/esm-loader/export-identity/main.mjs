// Export binding identity and own-property export names (source review R1 and R2).
import * as hub from './hub.mjs';
import { x, bump, shadowed } from './hub.mjs';
import { __proto__ as p, constructor as c, toString as t, 'a-b' as ab } from './relay.mjs';
import * as proto from './proto.mjs';
import * as relay from './relay.mjs';

console.log(Object.keys(hub).join(), x, shadowed, 'y' in hub);
bump();
console.log(x, hub.x);
console.log(p, c, t, ab);
console.log(Reflect.ownKeys(proto).map(String).join());
console.log(Reflect.ownKeys(relay).map(String).join());
console.log(Object.hasOwn(proto, '__proto__'), JSON.stringify(Object.getOwnPropertyDescriptor(proto, '__proto__')));
console.log(proto.constructor === 2, proto.toString === 3, Object.getPrototypeOf(proto));
