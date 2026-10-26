import type { FeatureProbe, ProductApp, ProductCheck, ProductCommand } from "./product-types";
import { productMarker } from "./product-types";

const next16 = {
  next: "16.4.3",
  react: "19.2.0",
  "react-dom": "19.2.0",
  typescript: "5.9.3",
  "@types/node": "22.18.10",
  "@types/react": "19.2.2",
  "@types/react-dom": "19.2.2",
} as const;
const next15 = {
  next: "15.5.6",
  react: "19.2.0",
  "react-dom": "19.2.0",
  typescript: "5.9.3",
  "@types/node": "22.18.10",
  "@types/react": "19.2.2",
  "@types/react-dom": "19.2.2",
} as const;
const next14 = {
  next: "14.2.33",
  react: "18.3.1",
  "react-dom": "18.3.1",
  typescript: "5.9.3",
  "@types/node": "22.18.10",
  "@types/react": "18.3.12",
  "@types/react-dom": "18.3.1",
} as const;

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
  const name = major === "16" ? "proxy" : "middleware";
  return {
    [`${name}.ts`]: `import { NextResponse } from "next/server";

export function ${name}(_request: Request) {
  const response = NextResponse.next();
  response.headers.set("x-product-middleware", "${text}");
  return response;
}

export const config = { matcher: ["/api/middleware/:path*"] };
`,
  };
}

function appDynamicFiles(text: string, major: string, withActions: boolean, cacheComponents = false): Record<string, string> {
  const files: Record<string, string> = {
    "app/layout.tsx": appLayout(text),
    "app/page.tsx": appPage(text),
    "app/api/ssr/route.ts": `${cacheComponents ? "" : 'export const dynamic = "force-dynamic";\n\n'}export function GET(request: Request) {

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
  if (withActions && major === "14") {
    Object.assign(files, appActionFiles(text, true));
    return files;
  }
  if (withActions) Object.assign(files, appActionFiles(text));
  return files;
}

function appActionFiles(text: string, react18 = false): Record<string, string> {
  const form = react18 ? `"use client";

import { useFormState, useFormStatus } from "react-dom";
import { submitValue } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>Invoke server action</button>;
}

export default function ActionForm() {
  const [result, formAction] = useFormState(submitValue, "");
  return <form action={formAction}>
    <input name="value" defaultValue="submitted" />
    <SubmitButton />
    <output data-action-result>{result}</output>
  </form>;
}
` : `"use client";

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
`;
  return {
    "app/action/actions.ts": `"use server";

export async function submitValue(previous: string, formData: FormData) {
  const value = String(formData.get("value") ?? "missing");
  return previous + "${text} server-action:" + value;
}
`,
    "app/action/action-form.tsx": form,
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
  props: { generated: "${text} isr generation:" + Date.now().toString() },
  revalidate: 1,
});

export default function IsrPage({ generated }: { generated: string }) {
  return <main data-isr-generation={generated}><h1>{generated}</h1></main>;
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

function nextConfigFile(major: string, expression: string): Record<string, string> {
  if (major === "14") return {
    "next.config.mjs": `const nextConfig = ${expression};
export default nextConfig;
`,
  };
  return {
    "next.config.ts": `import type { NextConfig } from "next";

const nextConfig: NextConfig = ${expression};
export default nextConfig;
`,
  };
}

function pprFiles(text: string, major: string): Record<string, string> {
  const config = major === "16" ? "{ cacheComponents: true }" : "{ experimental: { ppr: true } }";
  const routeConfig = major === "15" ? "export const experimental_ppr = true;\n\n" : "";
  return {
    ...nextConfigFile(major, config),
    "app/ppr/page.tsx": `import { Suspense } from "react";
import { connection } from "next/server";

async function DelayedServerData() {
  await connection();
  await new Promise(resolve => setTimeout(resolve, 100));
  return <p data-ppr-deferred>${text} ppr deferred</p>;
}

${routeConfig}
export default function PprPage() {
  return <main>
    <p data-ppr-shell>${text} ppr early-shell</p>
    <Suspense fallback={<p data-ppr-fallback>${text} ppr fallback</p>}>
      <DelayedServerData />
    </Suspense>
  </main>;
}
`,
  };
}

function staticFiles(text: string, router: "app" | "pages", major: string): Record<string, string> {
  const files: Record<string, string> = {
    ...nextConfigFile(major, '{ output: "export" }'),
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

function pageCheck(text: string, hmr = true, probes: readonly FeatureProbe[] = []): Extract<ProductCheck, { kind: "page" }> {
  return {
    kind: "page",
    selector: "h1",
    text,
    ...(hmr ? { hmr: { path: "app/page.tsx", search: text, replacement: `${text} updated` } } : {}),
    ...(probes.length ? { probes } : {}),
  };
}

function pagesCheck(text: string, hmr = true, probes: readonly FeatureProbe[] = []): Extract<ProductCheck, { kind: "page" }> {
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

function bundlerArgs(version: string): readonly string[] {
  return version === "16" ? ["--webpack"] : [];
}

function dynamicCommands(version: string, check: Extract<ProductCheck, { kind: "page" }>): readonly ProductCommand[] {
  const productionCheck: Extract<ProductCheck, { kind: "page" }> = {
    kind: "page",
    selector: check.selector,
    text: check.text,
    ...(check.probes ? { probes: check.probes } : {}),
  };
  return [
    { name: "dev", args: ["run", "node_modules/next/dist/bin/next", "dev"].concat(bundlerArgs(version), ["--hostname", "127.0.0.1", "--port", "{port}"]), check },
    { name: "build", args: ["run", "node_modules/next/dist/bin/next", "build"].concat(bundlerArgs(version)), check: { kind: "files", paths: [".next/BUILD_ID"], text: "" }, },
    { name: "start", after: "build", args: ["run", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "{port}"], check: productionCheck },
  ];
}

function staticCommands(version: string, text: string, router: "app" | "pages"): readonly ProductCommand[] {
  const check = router === "app" ? pageCheck(text) : pagesCheck(text);
  const previewCheck = router === "app" ? pageCheck(text, false) : pagesCheck(text, false);
  return [
    { name: "dev", args: ["run", "node_modules/next/dist/bin/next", "dev"].concat(bundlerArgs(version), ["--hostname", "127.0.0.1", "--port", "{port}"]), check },
    { name: "build", args: ["run", "node_modules/next/dist/bin/next", "build"].concat(bundlerArgs(version)), check: { kind: "files", paths: ["out/index.html"], text }, },
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
    commands: dynamicCommands(version, pageCheck(text, true, appProbes(text, withActions))),
    features: [
      "router:app",
      "mode:dev-hmr",
      "mode:production-start",
      "ssr:response-probe",
      version === "16" ? "middleware:proxy-response-probe" : "middleware:response-probe",
      withActions ? "server-actions:action-probe" : "server-actions:n/a-react-18-catalog",
      "isr:n/a-app-router-sequence-probe-pending",
      version === "15" ? "ppr:experimental-available-separate-case" : "ppr:n/a-standard-app-case",
    ],
  };
}

function dynamicPprApp(version: "15" | "16", dependencies: Record<string, string>): ProductApp {
  const text = marker(version, "app", "server");
  const pprText = `${text} ppr`;
  return {
    id: version === "15" ? "next-15-app-ppr-experimental" : "next-16-app-ppr",
    family: "next",
    dependencies,
    files: {
      ...appDynamicFiles(text, version, false, version === "16"),
      ...pprFiles(pprText, version),
    },
    commands: dynamicCommands(version, pageCheck(text, true, appProbes(text, false))),
    features: [
      "router:app",
      "mode:dev-hmr",
      "mode:production-start",
      "ssr:response-probe",
      version === "16" ? "middleware:proxy-response-probe" : "middleware:response-probe",
      "server-actions:n/a-ppr-fixture",
      "isr:n/a-ppr-fixture",
      version === "16" ? "ppr:pending-cache-components-stream-probe" : "ppr:experimental-pending-stream-probe",
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
    commands: dynamicCommands(version, pagesCheck(text, true, pagesProbes(text))),
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
    files: staticFiles(text, router, version),
    commands: staticCommands(version, text, router),
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
  dynamicPprApp("16", next16),
  dynamicPages("16", next16),
  staticApp("16", next16, "app"),
  staticApp("16", next16, "pages"),
  dynamicApp("15", next15, true),
  dynamicPprApp("15", next15),
  dynamicPages("15", next15),
  staticApp("15", next15, "app"),
  staticApp("15", next15, "pages"),
  dynamicApp("14", next14, true),
  dynamicPages("14", next14),
  staticApp("14", next14, "app"),
  staticApp("14", next14, "pages"),
];
