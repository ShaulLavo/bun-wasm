### Round-5 native stream reflection and abort cleanup

Class **Host feature**, original bridge refinement. `web/src/native-stream-state.ts` now rewrites each wrapped native stream prototype's `constructor` descriptor to the wrapper, preserving `instance.constructor === GlobalConstructor` and subclassing while retaining native prototypes and brands. Guest abort signals passed to native `pipeTo` are mirrored through a native controller. The guest listener is detached when the native pipe fulfills or rejects and when the native call throws synchronously. The browser fixture counts add/remove operations across repeated successful pipes.


[Parent context](http-framing.md).
