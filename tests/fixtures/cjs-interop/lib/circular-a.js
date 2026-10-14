exports.done = false;
const b = require("./circular-b");
exports.sawB = b.done;
exports.done = true;
