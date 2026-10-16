const { callerSourceOrigin } = require("bun:jsc");
exports.helper = function () {
  return { origin: callerSourceOrigin() };
};
