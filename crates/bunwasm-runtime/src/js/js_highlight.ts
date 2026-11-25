// Bun's QuickAndDirtyJavaScriptSyntaxHighlighter (bun_core/fmt.rs, `fmt_javascript`), which
// colours the source lines above an error. Ported without the npm-secret redaction mode, which
// only `bun install` output uses.
(function () {
  "use strict";

  const RESET = "\u001b[0m";
  const MAGENTA = "\u001b[35m";
  const BLUE = "\u001b[34m";
  const ORANGE = "\u001b[33m";
  const RED = "\u001b[31m";
  const GREEN = "\u001b[32m";
  const BOLD = "\u001b[1m";
  const DIM = "\u001b[2m";
  const ITALIC = "\u001b[3m";

  const BLUE_WORDS = "abstract as enum implements interface private protected public type string number boolean symbol any object unknown never namespace declare readonly";
  const ORANGE_WORDS = "undefined false null this true";
  const MAGENTA_WORDS = "async await case catch class const continue debugger default do else break export extends finally for function if import in instanceof let new package return static super switch throw try typeof var void while with yield";
  const KEYWORDS = new Map<string, string>();
  for (const word of BLUE_WORDS.split(" ")) KEYWORDS.set(word, BLUE);
  for (const word of ORANGE_WORDS.split(" ")) KEYWORDS.set(word, ORANGE);
  for (const word of MAGENTA_WORDS.split(" ")) KEYWORDS.set(word, MAGENTA);
  KEYWORDS.set("delete", RED);

  // Words after which the next identifier is a declared name.
  const DECLARES = new Set(["abstract", "namespace", "declare", "type", "interface"]);

  // The text is ASCII here (see `highlight`), so the identifier tables are the ASCII ones.
  function identifierStart(ch: string | undefined) {
    return ch !== undefined && /[A-Za-z_$]/.test(ch);
  }

  function identifierContinue(ch: string | undefined) {
    return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  }

  function isAllAscii(text: string) {
    // oxlint-disable-next-line no-control-regex -- ASCII check matches every byte below 0x80.
    return /^[\x00-\x7f]*$/.test(text);
  }

  class Highlighter {
    out = "";
    prev: string | null = null;

    run(input: string) {
      let text = input;
      while (text.length > 0) text = this.step(text);
    }

    step(text: string): string {
      const ch = text[0];
      if (identifierStart(ch)) return this.word(text);
      if (ch >= "0" && ch <= "9") return this.number(text);
      if (ch === "`" || ch === "\"" || ch === "'") return this.quoted(text, ch);
      if (ch === "/") return this.slash(text);
      if (ch === "{" || ch === "}") {
        if (this.prev !== "import") this.prev = null;
        this.out += ch;
        return text.slice(1);
      }
      if (ch === "[" || ch === "]") {
        this.prev = null;
        this.out += ch;
        return text.slice(1);
      }
      if (ch === ";") {
        this.prev = null;
        this.out += RESET + DIM + ";" + RESET;
        return text.slice(1);
      }
      if (ch === ".") return this.dot(text);
      if (ch === "<") {
        this.prev = null;
        this.out += RESET + "<" + RESET;
        return text.slice(1);
      }
      this.out += ch;
      return text.slice(1);
    }

    word(text: string) {
      let i = 1;
      while (i < text.length && identifierContinue(text[i])) i++;
      const word = text.slice(0, i);
      const color = KEYWORDS.get(word);
      if (color !== undefined) {
        if (word !== "as") this.prev = word;
        this.out += RESET + color + word + RESET;
        return text.slice(i);
      }
      this.out += this.plainWord(word, text[i]);
      return text.slice(i);
    }

    plainWord(word: string, next: string | undefined) {
      const prev = this.prev;
      if (prev === "new") {
        this.prev = null;
        if (next === "(") return RESET + BOLD + word + RESET;
      } else if (prev !== null && DECLARES.has(prev)) {
        this.prev = null;
        return RESET + BOLD + BLUE + word + RESET;
      } else if (prev === "import" && word === "from") {
        this.prev = null;
        return RESET + MAGENTA + word + RESET;
      }
      return word;
    }

    number(text: string) {
      this.prev = null;
      let i = 1;
      if (text.length > 1 && text[0] === "0" && (text[1] === "x" || text[1] === "X")) {
        i++;
        while (i < text.length && /[0-9A-Fa-f_]/.test(text[i])) i++;
      } else {
        while (i < text.length && /[0-9.eExXbBoO_]/.test(text[i])) i++;
      }
      if (text[i] === "n") i++;
      this.out += RESET + ORANGE + text.slice(0, i) + RESET;
      return text.slice(i);
    }

    // A string literal; a template literal highlights its `${...}` parts as code.
    quoted(input: string, quote: string) {
      this.prev = null;
      let text = input;
      let i = 1;
      while (i < text.length && text[i] !== quote) {
        if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
          const rest = this.interpolation(text, i);
          if (rest.closed) return rest.text;
          text = rest.text;
          i = 0;
          continue;
        }
        if (i + 1 < text.length && text[i] === "\\") i++;
        i++;
      }
      if (i < text.length) i++;
      this.out += RESET + GREEN + text.slice(0, i) + RESET;
      return text.slice(i);
    }

    // Writes the template text before `${`, the highlighted expression and `}`. Returns the
    // text after it, and whether a closing backtick right after it ended the literal.
    interpolation(text: string, start: number) {
      let i = start + 2;
      while (i < text.length && text[i] !== "}") {
        if (i + 1 < text.length && text[i] === "\\") i++;
        i++;
      }
      this.out += RESET + GREEN + text.slice(0, start) + RESET + "${";
      const inner = new Highlighter();
      inner.run(text.slice(start + 2, i));
      this.out += inner.out;
      if (i < text.length && text[i] === "}") {
        this.out += "}";
        i++;
      }
      const rest = text.slice(i);
      if (rest[0] === "`") {
        this.out += RESET + GREEN + "`" + RESET;
        return { text: rest.slice(1), closed: true };
      }
      return { text: rest, closed: false };
    }

    slash(text: string) {
      this.prev = null;
      if (text[1] === "/") {
        let i = 1;
        while (i < text.length && text[i] !== "\n") i++;
        const comment = text.slice(0, i);
        if (text[i] === "\n") i++;
        if (text[i] === "\r") i++;
        this.out += RESET + DIM + comment + RESET;
        return text.slice(i);
      }
      if (text[1] === "*") {
        let i = 2;
        while (i + 2 < text.length && text.slice(i, i + 2) !== "*/") i++;
        if (i + 2 < text.length && text.slice(i, i + 2) === "*/") {
          i += 2;
          this.out += RESET + DIM + text.slice(0, i) + RESET;
          return text.slice(i);
        }
      }
      this.out += "/";
      return text.slice(1);
    }

    dot(text: string) {
      this.prev = null;
      if (identifierStart(text[1]) || text[1] === "#") {
        let i = 2;
        while (i < text.length && identifierContinue(text[i])) i++;
        if (text[i] === "(") {
          this.out += RESET + ITALIC + BOLD + text.slice(0, i) + RESET;
          return text.slice(i);
        }
      }
      this.out += ".";
      return text.slice(1);
    }
  }

  /** Highlighted `text`, or `text` itself when colours are off or it is long or not ASCII. */
  function highlight(text: string, colors: boolean) {
    if (!colors || text.length > 2048 || text.length === 0 || !isAllAscii(text)) return text;
    const h = new Highlighter();
    h.run(text);
    return h.out;
  }

  return { highlight };
})
