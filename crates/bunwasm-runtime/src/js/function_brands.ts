// A bound function or a host function carries the async or generator prototype of its target
// without being one, and Node answers false for it. Those print as the engine's native-function
// placeholder, not as source.
(function () {
  "use strict";
  const functionSource = Function.prototype.toString;
  // The whole placeholder, not a source that merely ends with the same text in a comment.
  const nativeSource = /^function\s*[\w$]*\s*\(\)\s*\{\s*\[native code\]\s*\}$/;

  function isNativePlaceholder(value: Function): boolean {
    try {
      return nativeSource.test(Reflect.apply(functionSource, value, []));
    } catch {
      return true;
    }
  }

  return { isNativePlaceholder };
})
