import type { FeatureProbe, ProductApp, ProductCheck, ProductCommand } from "./product-types";
import { productMarker } from "./product-types";

const next16 = { next: "16.4.3", react: "19.2.0", "react-dom": "19.2.0" } as const;
const next15 = { next: "15.5.6", react: "19.2.0", "react-dom": "19.2.0" } as const;
const next14 = { next: "14.2.33", react: "18.3.1", "react-dom": "18.3.1" } as const;

const marker = (version: string, router: "app" | "pages", mode: "server" | "static") =>
  `${productMarker} next-${version}-${router}-${mode}`;

const appLayout = (text: string) => `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><head><meta name="x-product-layout" content="${text}" /></head><body>{children}</body></html>;
}
`;

function appPage(text: string): string {
  return `export default function Page() {
  return <main><h1>${text}</h1><p>app-router</p></main>;
}
`;
}

function pagesPage(text: string): string {
  return `export default function Page() {
  return <main><h1>${text}</h1><p>pages-router</p></main>;
}
`;
}

function requestBoundary(text: string, major: string): Record<string, string> {
  if (major === "16") return {
    "proxy.ts": `import { NextResponse } from "next/server";

export function proxy(_request: Request) {
  const response = NextResponse.next();
  response.headers.set("x-product-middleware", "${text}");
  return response;
}

export const config = { matcher: ["/api/middleware/:path*"] };
`,
  };
  return {
    "middleware.ts": `import { NextResponse } from "next/server";

export function middleware(_request: Request) {
  const response = NextResponse.next();
  response.headers.set("x-product-middleware", "${text}");
  return response;
}

export const config = { matcher: ["/api/middleware/:path*"] };
`,
  };
}

function appDynamicFiles(text: string, major: string, withActions: boolean): Record<string, string> {
  const files: Record<string, string> = {
    "app/layout.tsx": appLayout(text),
    "app/page.tsx": appPage(text),
    "app/api/ssr/route.ts": `export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("value") ?? "missing";
  return Response.json({ marker: "${text}", value }, { headers: { "cache-control": "no-store" } });
}
`,
    "app/api/middleware/route.ts": `export function GET() {
  return new Response("${text} middleware route");
}
`,
    ...requestBoundary(text, major),
  };
  if (withActions) Object.assign(files, appActionFiles(text));
  return files;
}

function appActionFiles(text: string): Record<string, string> {
  return {
    "app/action/actions.ts": `"use server";

export async function submitValue(previous: string, formData: FormData) {
  const value = String(formData.get("value") ?? "missing");
  return previous + "${text} server-action:" + value;
}
`,
    "app/action/action-form.tsx": `"use client";

import { useActionState } from "react";
import { submitValue } from "./actions";

export default function ActionForm() {
  const [result, formAction, pending] = useActionState(submitValue, "");
  return <form action={formAction}>
    <input name="value" defaultValue="submitted" />
    <button type="submit" disabled={pending}>Invoke server action</button>
    <output data-action-result>{result}</output>
  </form>;
}
`,
    "app/action/page.tsx": `import ActionForm from "./action-form";

export default function ActionPage() {
  return <main><h1>${text} action</h1><ActionForm /></main>;
}
`,
  };
}

function pagesDynamicFiles(text: string, major: string): Record<string, string> {
  return {
    "pages/index.tsx": pagesPage(text),
    "pages/ssr.tsx": `import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps<{ value: string }> = async ({ query }) => ({
  props: { value: String(query.value ?? "missing") },
});

export default function ServerPage({ value }: { value: string }) {
  return <main><h1>${text} ssr:{value}</h1></main>;
}
`,
    "pages/isr.tsx": `import type { GetStaticProps } from "next";

export const getStaticProps: GetStaticProps = async () => ({
  props: { generated: "${text} isr" },
  revalidate: 1,
});

export default function IsrPage({ generated }: { generated: string }) {
  return <main><h1>{generated}</h1></main>;
}
`,
    "pages/api/middleware.ts": `import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_request: NextApiRequest, response: NextApiResponse) {
  response.status(200).send("${text} middleware route");
}
`,
    ...requestBoundary(text, major),
  };
}

function staticFiles(text: string, router: "app" | "pages"): Record<string, string> {
  const files: Record<string, string> = {
    "next.config.ts": `import type { NextConfig } from "next";

const nextConfig: NextConfig = { output: "export" };
export default nextConfig;
`,
    "preview.ts": `import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = join(process.cwd(), "out");
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = Bun.serve({
  port: Number(process.env.PORT ?? "3137"),
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    try {
      const body = await readFile(join(root, relative));
      return new Response(body, { headers: { "content-type": contentTypes[extname(relative)] ?? "text/plain; charset=utf-8" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
});
console.log("${text} static preview listening", server.port);
`,
  };
  const page = router === "app" ? appPage(text) : pagesPage(text);
  Object.assign(files, router === "app" ? { "app/layout.tsx": appLayout(text), "app/page.tsx": page } : { "pages/index.tsx": page });
  return files;
}

function pageCheck(text: string, hmr = true, probes: readonly FeatureProbe[] = []): ProductCheck {
  return {
    kind: "page",
    selector: "h1",
    text,
    ...(hmr ? { hmr: { path: "app/page.tsx", search: text, replacement: `${text} updated` } } : {}),
    ...(probes.length ? { probes } : {}),
  };
}

function pagesCheck(text: string, hmr = true, probes: readonly FeatureProbe[] = []): ProductCheck {
  return {
    kind: "page",
    selector: "h1",
    text,
    ...(hmr ? { hmr: { path: "pages/index.tsx", search: text, replacement: `${text} updated` } } : {}),
    ...(probes.length ? { probes } : {}),
  };
}

function appProbes(text: string, withActions: boolean): readonly FeatureProbe[] {
  const probes: FeatureProbe[] = [
    { kind: "response", id: "app-ssr-response", path: "/api/ssr?value=probe", status: 200, text: `"value":"probe"` },
    { kind: "response", id: "middleware-response", path: "/api/middleware", status: 200, text: `${text} middleware route`, header: { name: "x-product-middleware", value: text } },
  ];
  if (withActions) probes.push({ kind: "action", id: "server-action", path: "/action", button: "button", selector: "[data-action-result]", text: `${text} server-action:submitted` });
  return probes;
}

function pagesProbes(text: string): readonly FeatureProbe[] {
  return [
    { kind: "route", id: "pages-ssr-route", path: "/ssr?value=probe", selector: "h1", text: `${text} ssr:probe` },
    { kind: "response", id: "middleware-response", path: "/api/middleware", status: 200, text: `${text} middleware route`, header: { name: "x-product-middleware", value: text } },
  ];
}

function dynamicCommands(text: string, check: ProductCheck): readonly ProductCommand[] {
  return [
    { name: "dev", args: ["run", "node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"], check },
    { name: "build", args: ["run", "node_modules/next/dist/bin/next", "build"], check: { kind: "files", paths: [".next/BUILD_ID"], text: "" }, },
    { name: "start", after: "build", args: ["run", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "{port}"], check: { ...check, hmr: undefined } },
  ];
}

function staticCommands(text: string, router: "app" | "pages"): readonly ProductCommand[] {
  const check = router === "app" ? pageCheck(text) : pagesCheck(text);
  const previewCheck = router === "app" ? pageCheck(text, false) : pagesCheck(text, false);
  return [
    { name: "dev", args: ["run", "node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"], check },
    { name: "build", args: ["run", "node_modules/next/dist/bin/next", "build"], check: { kind: "files", paths: ["out/index.html"], text }, },
    { name: "preview", after: "build", args: ["run", "preview.ts"], check: previewCheck },
  ];
}

function dynamicApp(version: string, dependencies: Record<string, string>, withActions: boolean): ProductApp {
  const text = marker(version, "app", "server");
  return {
    id: `next-${version}-app`,
    family: "next",
    dependencies,
    files: appDynamicFiles(text, version, withActions),
    commands: dynamicCommands(text, pageCheck(text, true, appProbes(text, withActions))),
    features: [
      "router:app",
      "mode:dev-hmr",
      "mode:production-start",
      "ssr:response-probe",
      version === "16" ? "middleware:proxy-response-probe" : "middleware:response-probe",
      withActions ? "server-actions:action-probe" : "server-actions:n/a-react-18-catalog",
      "isr:n/a-app-router-sequence-probe-pending",
      version === "16" ? "ppr:pending-cache-components-stream-probe" : "ppr:n/a-stable-release-no-ppr-contract",
    ],
  };
}

function dynamicPages(version: string, dependencies: Record<string, string>): ProductApp {
  const text = marker(version, "pages", "server");
  return {
    id: `next-${version}-pages`,
    family: "next",
    dependencies,
    files: pagesDynamicFiles(text, version),
    commands: dynamicCommands(text, pagesCheck(text, true, pagesProbes(text))),
    features: [
      "router:pages",
      "mode:dev-hmr",
      "mode:production-start",
      "ssr:route-probe",
      version === "16" ? "middleware:proxy-response-probe" : "middleware:response-probe",
      "isr:pending-cache-sequence-probe",
      "ppr:n/a-pages-router",
      "server-actions:n/a-pages-router-catalog",
    ],
  };
}

function staticApp(version: string, dependencies: Record<string, string>, router: "app" | "pages"): ProductApp {
  const text = marker(version, router, "static");
  return {
    id: `next-${version}-${router}-static`,
    family: "next",
    dependencies,
    files: staticFiles(text, router),
    commands: staticCommands(text, router),
    features: [
      `router:${router}`,
      "mode:dev-hmr",
      "mode:static-export",
      "mode:static-preview",
      "ssr:n/a-static-export",
      "isr:n/a-static-export",
      "ppr:n/a-static-export",
      "middleware:n/a-static-export",
      "server-actions:n/a-static-export",
    ],
  };
}

export const nextApps: ProductApp[] = [
  dynamicApp("16", next16, true),
  dynamicPages("16", next16),
  staticApp("16", next16, "app"),
  staticApp("16", next16, "pages"),
  dynamicApp("15", next15, true),
  dynamicPages("15", next15),
  staticApp("15", next15, "app"),
  staticApp("15", next15, "pages"),
  dynamicApp("14", next14, false),
  dynamicPages("14", next14),
  staticApp("14", next14, "app"),
  staticApp("14", next14, "pages"),
];
