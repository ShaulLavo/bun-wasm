let calls = 0;
const saved = Error.prepareStackTrace;
Error.prepareStackTrace = () => { calls++; return "early"; };
const errors = [new Error("unread"), new TypeError("unread")];
console.log("unread formatter calls", calls);
Error.prepareStackTrace = saved;
console.log("read string", typeof errors[0].stack === "string");
