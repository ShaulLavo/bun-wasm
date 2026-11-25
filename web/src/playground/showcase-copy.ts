// Every visible string of the playground showcase (demo bar, engine note, compatibility line,
// docked preview). Copy edits happen here; components only read these values.

import type { Engine } from "../engine-loader";

export const copy = {
  demoBarLabel: "Run in this tab",
  demoBarAria: "Bun API demos",
  /** Keyed by demo id (see demos.ts). Labels are API names; titles explain them on hover. */
  demos: {
    serve: { label: "Bun.serve", title: "Serve HTTP routes and a bun:sqlite visit counter in a live preview" },
    sqlite: { label: "bun:sqlite", title: "Create a SQLite table, insert rows in a transaction, and query todos.sqlite" },
    test: { label: "bun test", title: "Run bun:test with describe, test.each, mocks, and async assertions" },
    build: { label: "Bun.build", title: "Bundle and minify TSX and TypeScript into dist/ with linked sourcemaps" },
    shell: { label: "Bun.$", title: "Run shell globs, pipes, argument escaping, .json(), and exit codes" },
    file: { label: "Bun.file", title: "Write and read text and JSON with Bun.write on the persistent browser filesystem" },
  },
  engineLabel: "Engine",
  engineTitle: "Choose the JavaScript engine. Switching reloads the page.",
  /** Option text in the engine picker. */
  engineOptions: {
    browser: "Browser (native)",
    quickjs: "QuickJS (9 MB)",
    jsc: "JSC (43 MB)",
    spidermonkey: "SpiderMonkey (experimental)",
  } satisfies Record<Engine, string>,
  /** One line under the demos naming what runs the code right now. */
  engineNotes: {
    browser: "This page's own JavaScript engine runs Bun's runtime, with the toolchain in Wasm.",
    quickjs: "QuickJS runs in Wasm.",
    jsc: "JavaScriptCore, Bun's own engine, compiled to Wasm with no JIT.",
    spidermonkey: "SpiderMonkey runs in Wasm.",
  } satisfies Record<Engine, string>,
  compat: {
    text: "Framework matrix: 208 of 208 pass.",
    title: "13 frameworks across 4 engines and 4 browsers: Chrome, Firefox, desktop Safari, and iPhone Safari on the iOS simulator. All 208 passed every phase from install to cleanup, measured 2026-11-23.",
    linkText: "Compatibility",
    href: "https://github.com/ShaulLavo/bun-wasm/blob/main/docs/compatibility.md",
  },
  projectLabel: "Project",
  projectTitle: "Open a project template in its own workspace",
  examplesOption: "Bun API examples",
  /** The two-page switch after the wordmark, on both the sandbox and the playground. */
  siteNav: {
    aria: "Pages",
    sandbox: "Sandbox",
    sandboxTitle: "Open the browser app sandbox with live preview",
    playground: "Bun APIs",
    playgroundTitle: "Run Bun.serve, bun:sqlite, bun test, Bun.build, Bun.$, and Bun.file in the playground",
  },
  /** The header's main button: Run when idle, Stop while a command runs. */
  run: {
    run: "▶ Run",
    runTitle: "Save and run (Ctrl/Cmd-Enter)",
    stop: "■ Stop",
    stopTitle: "Stop the running command (press again to force it)",
  },
  /** The phone-only switch between the three panes of the examples workspace. */
  panes: {
    aria: "Pane",
    code: "Code",
    preview: "Preview",
    terminal: "Terminal",
    previewLive: "Server running",
  },
  /** The line the terminal prints when a server's preview is ready. */
  terminal: {
    previewLabel: "preview",
    previewHint: "Ctrl-C stops the server",
  },
  preview: {
    aria: "Server preview",
    frameTitle: "Server preview",
    waiting: "Waiting for the server",
    restart: "Restart",
    restartTitle: "Save the file and restart the server",
    open: "Open",
    openTitle: "Open the preview in a new tab",
    close: "Close",
    closeTitle: "Close the preview. The server keeps running.",
  },
} as const;

export type DemoId = keyof typeof copy.demos;
