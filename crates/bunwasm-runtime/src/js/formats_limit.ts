(function () {
  "use strict";
  function checkSize(input: { readonly byteLength: number }) {
    const byteLength = input.byteLength;
    if (byteLength <= 0x7fffffff) return;
    throw Object.assign(new RangeError(`The value of "input.byteLength" is out of range. It must be <= 2147483647. Received ${byteLength}`), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return { checkSize };
})
