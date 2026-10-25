import { registerModuleScope } from "../src/engine-loader";
import { Previews } from "../src/preview";

const previews = new Previews();
Reflect.set(globalThis, "previewLoading", {
  moduleReady: registerModuleScope(),
  async ready() {
    const first = previews.ready;
    const second = previews.ready;
    if (first !== second) throw new Error("Preview registration must be shared");
    return first;
  },
});
