const first = require("./parent.mts");
const second = require("./parent.mts");
console.log(first === second, typeof first.default, typeof first.run);
first.run();
const child = require("./child.mts");
console.log(child === require("./child.mts"), child.count, child.default === first.default);
