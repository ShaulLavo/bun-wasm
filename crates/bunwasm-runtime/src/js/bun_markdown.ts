// Bun.markdown: html() and ansi() over Bun's bun_md renderer (crates/bunwasm-build/src/markdown.rs),
// with the option parsing of Bun's src/runtime/api/MarkdownObject.rs (docs/bun-patches/bun-markdown.md).
// render() and react() call back into JavaScript for every node and are not ported yet.
(function (internal: BunWasm.Internal) {
  "use strict";
  const native = internal.native;
  // md::Options::BOOL_FIELD_SETTERS without the compound autolink and heading fields.
  const FLAGS: [string, string][] = [
    ["tables", "tables"], ["strikethrough", "strikethrough"], ["tasklists", "tasklists"],
    ["hard_soft_breaks", "hardSoftBreaks"], ["wiki_links", "wikiLinks"], ["underline", "underline"],
    ["latex_math", "latexMath"], ["collapse_whitespace", "collapseWhitespace"],
    ["permissive_atx_headers", "permissiveAtxHeaders"], ["no_indented_code_blocks", "noIndentedCodeBlocks"],
    ["no_html_blocks", "noHtmlBlocks"], ["no_html_spans", "noHtmlSpans"], ["tag_filter", "tagFilter"],
  ];
  type Options = Record<string, unknown>;

  function input(value: unknown): Uint8Array {
    if (typeof value === "string") return native.utf8Encode(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return internal.toUint8(value);
    throw Object.assign(new TypeError("Expected a string or buffer to render"), { code: "ERR_INVALID_ARG_TYPE" });
  }

  const isObject = (value: unknown): value is Options => value !== null && typeof value === "object";
  // Bun's get_boolean_loose: a present property counts by its truthiness.
  function loose(options: Options, key: string): boolean | undefined {
    const value = options[key];
    return value === undefined ? undefined : Boolean(value);
  }

  function compound(flags: Record<string, boolean>, value: unknown, all: string[], parts: [string, string][]) {
    if (typeof value === "boolean") {
      if (value) for (const name of all) flags[name] = true;
      return;
    }
    if (!isObject(value)) return;
    for (const [key, name] of parts) {
      const set = loose(value, key);
      if (set !== undefined) flags[name] = set;
    }
  }

  function htmlFlags(options: unknown): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    if (!isObject(options)) return flags;
    compound(flags, options.autolinks, ["permissive_autolinks"],
      [["url", "permissive_url_autolinks"], ["www", "permissive_www_autolinks"], ["email", "permissive_email_autolinks"]]);
    compound(flags, options.headings, ["heading_ids", "autolink_headings"], [["ids", "heading_ids"], ["autolink", "autolink_headings"]]);
    for (const [snake, camel] of FLAGS) {
      const set = loose(options, camel) ?? (camel === snake ? undefined : loose(options, snake));
      if (set !== undefined) flags[snake] = set;
    }
    return flags;
  }

  function ansiTheme(theme: unknown): Options {
    if (!isObject(theme)) return {};
    const out: Options = {};
    for (const key of ["colors", "hyperlinks", "kittyGraphics", "light"]) {
      const set = loose(theme, key);
      if (set !== undefined) out[key] = set;
    }
    if (typeof theme.columns === "number") out.columns = Math.max(0, Math.trunc(theme.columns) | 0);
    return out;
  }

  function notPorted(name: string) {
    return function () {
      throw Object.assign(new Error(`Bun.markdown.${name} is not supported in bun-wasm yet: it calls back into JavaScript for every node`), { code: "ERR_NOT_SUPPORTED_IN_WASM" });
    };
  }

  const markdown = {
    html(text: unknown, options?: unknown): string {
      return native.markdown("html", input(text), JSON.stringify({ flags: htmlFlags(options) }));
    },
    ansi(text: unknown, theme?: unknown): string {
      return native.markdown("ansi", input(text), JSON.stringify(ansiTheme(theme)));
    },
    render: notPorted("render"),
    react: notPorted("react"),
  };
  return { markdown };
})
