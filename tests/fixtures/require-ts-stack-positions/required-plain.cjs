// A plain CommonJS module, loaded with require() without compiling it.
function parse(text) {
  const value = Number(text);
  if (Number.isNaN(value)) throw new TypeError(`not a number: ${text}`);
  return value;
}

module.exports = { parse };
