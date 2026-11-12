# Starter counter readiness

Classification: original local adapters.

The Next Pages and App Router, React Router, SolidStart, Nuxt, Astro and Hono
starter counters now render disabled until their client handlers are installed.
React uses a mount effect, Solid uses onMount, Nuxt uses onMounted, and the static
scripts enable their buttons after registering listeners. The existing SvelteKit
and TanStack Start starters already use this pattern.

These are local starter UI changes, not patches to framework source. An enabled
SSR button previously let the goals runner click before hydration and lose that
click. The unchanged maintained Next browser control passed after its client
readiness check. The goals runner still performs one successful click and observes
the counter; it adds no retries, navigation, longer timeout or framework fallback.

The source-level readiness regression is feature-owned under checks/. The real
matrix remains the end-to-end test of hydration, interaction and hot reload.
