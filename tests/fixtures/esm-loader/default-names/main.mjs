// Anonymous defaults are named "default" and keep their anonymous source; named
// defaults keep their names; an anonymous default function is hoisted for a cycle.
import './hoist.mjs';
import fn from './fn.mjs';
import cls from './cls.mjs';
import arrow from './arrow.mjs';
import agen from './agen.mjs';
import named from './named.mjs';
import expr from './expr.mjs';
const anonymous = f => /^(async\s*)?function\s*\*?\s*\(/.test(String(f));
console.log(fn.name, fn(), anonymous(fn), cls.name, cls.seen, globalThis.blockName);
console.log(arrow.name, agen.name, anonymous(agen), named.name, expr.name, anonymous(expr));
