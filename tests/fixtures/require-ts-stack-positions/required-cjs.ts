// A CommonJS module in TypeScript, loaded with require().
interface Options {
  strict: boolean;
}

type Parsed = { value: number };

function parse(text: string, options: Options): Parsed {
  const value = Number(text);
  if (options.strict && Number.isNaN(value)) throw new TypeError(`not a number: ${text}`);
  return { value };
}

module.exports = { parse };
