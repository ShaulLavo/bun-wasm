# Goals framework starters

Classification: original adapters and local fixture reuse.

The new `sandbox/template-*` apps are plain starter projects. SvelteKit, Nuxt,
Astro, React Router, SolidStart, TanStack Start, Vue, and Svelte reuse the maintained
local examples from `scripts/app-matrix/product-fullstack.ts` and `product-vite.ts`
at bun-wasm `567812a39`. Their existing upstream records remain authoritative for
those source adaptations. The copies use a normal greeting instead of the product
matrix marker and put commands in each app's package.json.

Angular, Qwik, and Hono are original minimal adapters to their public APIs, not
copied upstream source. Angular uses standalone bootstrap and the application
builder. Qwik uses the Vite optimizer in client-rendering mode. Hono serves a
counter page and a Bun-built client script. Each app has a development command,
a production build, and a production start command. A failed framework command
is evidence, not a reason for the runner to substitute a synthetic page.

The Qwik 1.17.2 client optimizer drops a top-level `void render(...)` expression when `isServer` is false, including its call's side effects. The starter calls `render(...)` directly so its client entry remains in the development and production output. `scripts/qwik-starter.test.ts` runs the pinned optimizer against that source and checks that the render call survives. No Qwik upstream source is patched.
