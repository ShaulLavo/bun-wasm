// Bun's terminal colour decision and its `<tag>` markup (bun_core/output.rs).
//
// Bun decides once per process whether stdout and stderr get ANSI colours: FORCE_COLOR
// (non-zero) turns both on, a truthy NO_COLOR turns both off, otherwise each stream follows
// its own isatty. Its reporter and matcher messages are written as templates such as
// `<r><green>✓<r>`, which become escape sequences when colours are on and vanish when off.
(function (internal: BunWasm.PrettyOutputInternal) {
  "use strict";

  const RESET = "\u001b[0m";
  const TAGS: Readonly<Record<string, string>> = {
    b: "\u001b[1m",
    d: "\u001b[2m",
    i: "\u001b[3m",
    u: "\u001b[4m",
    black: "\u001b[30m",
    red: "\u001b[31m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    blue: "\u001b[34m",
    magenta: "\u001b[35m",
    cyan: "\u001b[36m",
    white: "\u001b[37m",
    bgred: "\u001b[41m",
    bggreen: "\u001b[42m",
  };

  // env_var.rs `boolean::string_is_truthy`.
  function truthy(value: string) {
    return !["", "0", "false", "no", "off"].includes(value.toLowerCase());
  }

  // FORCE_COLOR is an unsigned level; "" means 1 and a non-number is cast through truthiness.
  function forced(value: string | undefined) {
    if (value === undefined) return false;
    if (value === "") return true;
    if (/^\d+$/.test(value)) return Number(value) !== 0;
    return truthy(value);
  }

  let decided: { stdout: boolean; stderr: boolean } | null = null;

  function decide() {
    if (decided) return decided;
    const env: Record<string, string | undefined> = globalThis.process.env ?? {};
    let both: boolean | null = null;
    if (forced(env.FORCE_COLOR)) both = true;
    else if (env.NO_COLOR !== undefined && truthy(env.NO_COLOR)) both = false;
    decided = {
      stdout: both ?? internal.native.isatty(1),
      stderr: both ?? internal.native.isatty(2),
    };
    return decided;
  }

  // output.rs `pretty_fmt_runtime`: `<name>` becomes its escape, `<r>` and `</name>` reset,
  // `\<` and `\>` are literal, unknown tags vanish, and braces pass through.
  function prettyFmt(template: string, enabled: boolean) {
    let out = "";
    let i = 0;
    while (i < template.length) {
      const ch = template[i];
      if (ch === "\\" && (template[i + 1] === "<" || template[i + 1] === ">")) {
        out += template[i + 1];
        i += 2;
        continue;
      }
      if (ch === ">") {
        i++;
        continue;
      }
      if (ch !== "<") {
        out += ch;
        i++;
        continue;
      }
      const close = template.indexOf(">", i + 1);
      const end = close < 0 ? template.length : close;
      let name = template.slice(i + 1, end);
      const reset = name.startsWith("/") || name === "r";
      if (name.startsWith("/")) name = name.slice(1);
      if (enabled) out += reset ? RESET : (TAGS[name] ?? "");
      i = end + 1;
    }
    return out;
  }

  // A template tag that applies the markup to the literal parts only, as Bun's `pretty_fmt!`
  // rewrites the format string before the values are substituted.
  function markup(enabled: boolean) {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      let out = prettyFmt(strings[0], enabled);
      for (let i = 0; i < values.length; i++) out += String(values[i]) + prettyFmt(strings[i + 1], enabled);
      return out;
    };
  }

  return {
    RESET,
    get stdout() {
      return decide().stdout;
    },
    get stderr() {
      return decide().stderr;
    },
    prettyFmt,
    markup,
  };
})
