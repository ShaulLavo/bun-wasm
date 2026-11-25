// Every visible string of the playground showcase (demo bar, engine note, compatibility line,
// docked preview). Copy edits happen here; components only read these values.

import type { Engine } from "../engine-loader";

export const copy = {
  demoBarLabel: "Run in this tab",
  demoBarAria: "Bun API demos",
  /** Keyed by demo id (see demos.ts). Labels are API names; titles explain them on hover. */
  demos: {
    serve: { label: "Bun.serve", title: "HTTP server with routes and a bun:sqlite counter, shown in a live preview" },
    sqlite: { label: "bun:sqlite", title: "SQLite compiled to WebAssembly" },
    test: { label: "bun test", title: "Bun's Jest-compatible test runner" },
    build: { label: "Bun.build", title: "Bun's bundler, minifying TSX and TypeScript into dist/" },
    shell: { label: "Bun.$", title: "Bun's shell: pipes, redirects and escaping" },
    file: { label: "Bun.file", title: "Bun.write and Bun.file on the persistent browser filesystem" },
  },
  engineLabel: "Engine",
  engineTitle: "JavaScript engine (reloads the page)",
  /** Option text in the engine picker. */
  engineOptions: {
    browser: "Browser (native)",
    quickjs: "QuickJS (9 MB)",
    jsc: "JSC (43 MB)",
    spidermonkey: "SpiderMonkey (experimental)",
  } satisfies Record<Engine, string>,
  /** One line under the demos naming what runs the code right now. */
  engineNotes: {
    browser: "Running on this browser's own JavaScript engine, with Bun's runtime in Wasm.",
    quickjs: "Running on QuickJS compiled to Wasm.",
    jsc: "Running on JavaScriptCore, Bun's own engine, compiled to Wasm (no JIT).",
    spidermonkey: "Running on SpiderMonkey compiled to Wasm.",
  } satisfies Record<Engine, string>,
  compat: {
    text: "Framework matrix: 208 of 208 pass",
    title: "13 frameworks, 4 browsers (Chrome, Firefox, desktop Safari, iPhone Safari on the iOS simulator) and 4 engines; every phase from install to cleanup. Measured 2026-11-23.",
    linkText: "Compatibility",
    href: "https://github.com/ShaulLavo/bun-wasm/blob/main/docs/compatibility.md",
  },
  projectLabel: "Project",
  projectTitle: "Open a project template in its own workspace",
  examplesOption: "Bun API examples",
  // The sandbox's link to these demos is DEMOS_LINK in sandbox/src/app.tsx.
  sandboxLink: "Sandbox",
  sandboxTitle: "React sandbox with hot reload",
  preview: {
    aria: "Server preview",
    frameTitle: "Server preview",
    restart: "Restart",
    restartTitle: "Save the file and restart the server",
    open: "Open",
    openTitle: "Open the preview in a new tab",
    close: "Close",
    closeTitle: "Close the preview (the server keeps running)",
  },
} as const;

export type DemoId = keyof typeof copy.demos;
