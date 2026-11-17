(function () {
  "use strict";

  function missingArguments() {
    return Object.assign(new TypeError("Not enough arguments"), { code: "ERR_MISSING_ARGS" });
  }

  function invalidURL(input: string, base?: string) {
    const error = Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL", input });
    return base === undefined ? error : Object.assign(error, { base });
  }

  function toString(value: unknown) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    return String(value);
  }

  return { missingArguments, invalidURL, toString };
})
