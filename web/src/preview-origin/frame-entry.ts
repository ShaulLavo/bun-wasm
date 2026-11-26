// Entry of preview-frame.html, the built new-tab wrapper page of the playground and sandbox.
import { showPreviewFrame } from "./frame-page";
import { resolvePreviewOriginConfig } from "./protocol";

showPreviewFrame(resolvePreviewOriginConfig(location, Reflect.get(globalThis, "__bunwasmPreviewOrigin")));
