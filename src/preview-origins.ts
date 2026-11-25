// Previews on their own origins, for any IDE built on this package (docs/preview-origins.md).
//
// The IDE page uses `RootPreviews`. The preview hosts are served by `handlePreviewOriginRequest`
// in a Worker or Bun.serve, with the built files from `bun-wasm/preview-origins/assets/*`. The
// IDE's own new-tab wrapper page calls `showPreviewFrame`.
export { RootPreviews, type RootPreviewsOptions } from "../web/src/preview-origin/root-previews.js";
export { showPreviewFrame } from "../web/src/preview-origin/frame-page.js";
export { handlePreviewOriginRequest, type PreviewOriginAsset, type PreviewOriginHostConfig } from "../web/src/preview-origin/host.js";
export {
  isPreviewOrigin, parsePreviewHost, previewHostEnv, previewOrigin, previewOriginId, resolvePreviewOriginConfig,
  type FrameMessage, type PreviewOriginConfig,
} from "../web/src/preview-origin/protocol.js";
export type { PreviewState } from "../web/src/preview.js";
