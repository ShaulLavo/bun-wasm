(function () {
  return function socketOptions(options: unknown) {
    return Object.assign({ allowHalfOpen: false, readableHighWaterMark: 65536, writableHighWaterMark: 65536 }, options);
  };
})
