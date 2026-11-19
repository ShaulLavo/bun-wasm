declare namespace BunWasm {
  interface UrlErrors {
    missingArguments(): TypeError & { code: "ERR_MISSING_ARGS" };
    invalidURL(input: string, base?: string): TypeError & { code: "ERR_INVALID_URL"; input: string; base?: string };
    toString(value: unknown): string;
  }
  interface Internal {
    require(name: "url_errors"): UrlErrors;
  }
}
