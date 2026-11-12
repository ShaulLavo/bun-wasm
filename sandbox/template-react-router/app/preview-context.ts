import type { EntryContext } from 'react-router';

export function previewContext(request: Request, context: EntryContext): EntryContext {
  const basename = request.headers.get('x-bun-preview-base');
  if (basename === null) return context;
  const match = /^\/(?:[a-zA-Z0-9._~-]+\/)*__preview\/([1-9]\d{0,4})\/$/.exec(basename);
  if (!match || Number(match[1]) > 65535 || new URL(basename, request.url).pathname !== basename) {
    throw new Error('Invalid Bun preview mount');
  }
  if (!context.serverHandoffString) throw new Error('Missing React Router handoff');
  const handoff: unknown = JSON.parse(context.serverHandoffString);
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) throw new Error('Invalid React Router handoff');
  // Lazy discovery sends browser paths in a query that the path proxy cannot strip.
  const routeDiscovery = { ...context.routeDiscovery, mode: 'initial' as const };
  return {
    ...context,
    routeDiscovery,
    serverHandoffString: JSON.stringify({ ...handoff, basename, routeDiscovery }).replaceAll('<', '\\u003c'),
    staticHandlerContext: {
      ...context.staticHandlerContext,
      basename,
      location: { ...context.staticHandlerContext.location, pathname: basename.slice(0, -1) + context.staticHandlerContext.location.pathname },
    },
  };
}
