# React Router mounted sandbox preview

Status: Approved. Implemented; independent review and CI remain with the parent.

The public sandbox mounts previews at `/__preview/5173/`. Its proxy forwards `/`
to React Router, while hydration sees the mounted pathname. A client-only
basename correction also mismatches server-rendered links and was discarded.

The Bun preview adapter now derives an internal mount header from actual routing
metadata. The template validates it and derives matching server-rendering and
browser-handoff contexts after normal root request matching. Root previews omit
the metadata. Mounted rendering uses the full initial route manifest because
lazy discovery sends browser paths inside query parameters.

The regression was committed before the fix. It reproduces `404 Not Found`, then
checks real mounted and root development and production servers, hydration,
loader and route navigation, back navigation, SSR links and state-preserving HMR.
The test uses the actual preview worker and socket shim. Test fixtures add their
own second route; the starter remains unchanged except for its server adapter.

Independent review found that canonical encoded hosting directories were rejected.
The correction accepts the adapter's encoded path while retaining URL normalization
checks. The real server regression fails before with HTTP 500 for `/my%20app/`
and passes after for encoded spaces and Unicode hosting directories.

Evidence and rerunnable sandbox checks are under
`/work/reports/goals/sandbox-fixes/react-router/`. No Waffle source, package pin,
version, generated matrix or other framework template changed.
