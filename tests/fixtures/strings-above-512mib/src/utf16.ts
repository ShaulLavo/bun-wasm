// Astral characters keep this source UTF-16 inside Bun's printer.
export const emoji: string = "🦊🚀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢";
export const pairs = ["🦊", "🚀"].map((glyph) => glyph.codePointAt(0)!.toString(16));
