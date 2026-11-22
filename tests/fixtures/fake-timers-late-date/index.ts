// A program run with `bun run` that imports bun:test: the Date it sees is the one
// setSystemTime controls.
import { setSystemTime } from "bun:test";

const Captured = Date;
setSystemTime(5000);
console.log(Captured === Date, new Captured().getTime(), Date.now(), new Date().getTime());
console.log(new Date(0).toISOString(), Date.prototype.constructor === Date);
setSystemTime();
console.log(Date.now() > 5000);
