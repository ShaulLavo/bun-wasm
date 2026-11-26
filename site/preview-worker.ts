// The Worker behind every preview host (`<id>-<port>-pv.shaulavo.dev`, docs/preview-origins.md).
// It serves the preview origin's service worker and three fixed pages, and never an IDE file:
// once a preview's service worker is installed, no request of the app reaches this Worker again.
// Any name that does not have the exact preview shape gets a 404.
import { handlePreviewOriginRequest } from "../web/src/preview-origin/host";

interface PreviewEnv {
  ASSETS: Fetcher;
  /** The domain preview hosts end with. */
  PREVIEW_DOMAIN: string;
  /** Comma-separated IDE origins that may frame a preview. */
  IDE_ORIGINS: string;
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const response = handlePreviewOriginRequest(request, {
      domain: env.PREVIEW_DOMAIN,
      ideOrigins: env.IDE_ORIGINS.split(",").map(origin => origin.trim()).filter(Boolean),
      async asset(name) {
        const file = await env.ASSETS.fetch(new URL(`/${name}`, request.url));
        if (!file.ok) throw new Error(`Missing preview origin file: ${name}`);
        return file.text();
      },
    });
    return response ?? new Response("Not a preview host.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  },
} satisfies ExportedHandler<PreviewEnv>;
