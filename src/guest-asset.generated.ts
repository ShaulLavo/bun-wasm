// The package bridge's matching guest is published by the follow-on guest build.
// Never point this descriptor at the incompatible pre-package guest.
import type { BunWasmAsset } from "./assets.js";

export const BUN_WASM_ASSET: BunWasmAsset | null = null;
