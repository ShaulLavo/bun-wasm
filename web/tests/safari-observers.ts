// Loaded before each fixture's module so startup errors and lazy guest fetches are observed.
const pageErrors: string[] = [], consoleErrors: string[] = [], requests: string[] = [];
addEventListener("error", event => pageErrors.push(event instanceof ErrorEvent ? event.message : String(event)));
addEventListener("unhandledrejection", event => pageErrors.push(event instanceof PromiseRejectionEvent ? String(event.reason) : String(event)));
const nativeError = console.error;
console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); nativeError(...args); };
const nativeFetch = globalThis.fetch;
Reflect.set(globalThis, "fetch", (input: RequestInfo | URL, options?: RequestInit) => {
  requests.push(new URL(input instanceof Request ? input.url : String(input), location.href).href);
  return nativeFetch(input, options);
});
Reflect.set(globalThis, "safariObservations", { pageErrors, consoleErrors, requests });
