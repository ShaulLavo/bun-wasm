(function () {
  "use strict";
  if (typeof Error.captureStackTrace !== "function") return false;
  const descriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const prepare = Error.prepareStackTrace;
  const marker = {};
  const holder: { stack?: unknown } = {};
  try {
    Error.prepareStackTrace = () => marker;
    Error.captureStackTrace(holder);
    return holder.stack === marker;
  } finally {
    if (descriptor) {
      if (descriptor.set) Reflect.apply(descriptor.set, Error, [prepare]);
      Object.defineProperty(Error, "prepareStackTrace", descriptor);
    } else {
      Reflect.deleteProperty(Error, "prepareStackTrace");
    }
  }
})
