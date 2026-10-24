(function () {
  return function socketOptions(options: unknown) {
    const copied = Object.assign({ allowHalfOpen: false, readableHighWaterMark: 65536, writableHighWaterMark: 65536 }, options);
    copied.readableHighWaterMark ??= 65536;
    copied.writableHighWaterMark ??= 65536;
    return copied;
  };
})
