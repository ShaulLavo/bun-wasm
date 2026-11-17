(function () {
  "use strict";

  return function concatLength(length: number, maximum: number): number {
    if (length > maximum) throw new RangeError(`JavaScriptCore typed arrays are currently limited to ${maximum} bytes. To use an array this large, use an ArrayBuffer instead. If this is causing issues for you, please file an issue in Bun's GitHub repository.`);
    return length;
  };
})
