(function () {
  "use strict";
  function checkSize(input: Uint8Array) {
    if (input.byteLength <= 0x7fffffff) return;
    throw Object.assign(new RangeError(`The value of "input.byteLength" is out of range. It must be <= 2147483647. Received ${input.byteLength}`), {
      code: "ERR_OUT_OF_RANGE",
    });
  }
  return { checkSize };
})
