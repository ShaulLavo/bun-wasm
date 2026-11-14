//! Exact-source MagicString 0.30.21 ESM adaptation. See docs/bun-patches/magic-string-encoded-mappings.md.
use sha2::{Digest, Sha256};
use std::borrow::Cow;

const SOURCE_SHA256: &str = "d637092a6c7dd947e1b27aef30e97d1a5f59dc39b69ef8f4f0e37e766e4df159";

pub(super) fn adapt<'a>(source: &'a str, path: &str) -> Cow<'a, str> {
    if !path.ends_with("/node_modules/magic-string/dist/magic-string.es.mjs") {
        return Cow::Borrowed(source);
    }
    if format!("{:x}", Sha256::digest(source.as_bytes())) != SOURCE_SHA256 {
        return Cow::Borrowed(source);
    }
    let code = source.replacen("class Mappings {", &format!("{WRITER}class Mappings {{"), 1)
        .replace("this.raw[this.generatedCodeLine] = this.rawSegments = [];", "this.rawSegments = this.startLine();")
        .replacen("\n\taddEdit(sourceIndex, content, loc, nameIndex) {", "\n\tstartLine() { return this.raw[this.generatedCodeLine] = []; }\n\n\taddEdit(sourceIndex, content, loc, nameIndex) {", 1)
        .replacen("\tgenerateMap(options) {\n\t\treturn new SourceMap(this.generateDecodedMap(options));\n\t}\n", GENERATE_MAP, 1);
    Cow::Owned(code + SUFFIX)
}

const WRITER: &str = r#"class EncodedLines {
  buffer = new Uint8Array(16384);
  decoder = new TextDecoder;
  position = 0;
  output = "";
  line = 0;
  column = 0;
  source = 0;
  sourceLine = 0;
  sourceColumn = 0;
  name = 0;
  hasSegment = false;
  segmentCount = 0;
  write(value) {
    this.buffer[this.position++] = value;
    if (this.position !== this.buffer.length)
      return;
    this.output += this.decoder.decode(this.buffer);
    this.position = 0;
  }
  integer(value) {
    let encoded = value < 0 ? -value << 1 | 1 : value << 1;
    do {
      let digit = encoded & 31;
      encoded >>>= 5;
      if (encoded > 0)
        digit |= 32;
      this.write("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(digit));
    } while (encoded > 0);
  }
  startLine(line) {
    while (this.line < line) {
      this.write(59);
      this.line++;
    }
    this.column = 0;
    this.hasSegment = false;
    return this;
  }
  push(segment) {
    if (segment.length > 1) {
      this.mapped(segment[0], segment[1], segment[2], segment[3], segment.length === 5 ? segment[4] : -1);
      return;
    }
    if (this.hasSegment)
      this.write(44);
    this.hasSegment = true;
    this.segmentCount++;
    this.integer(segment[0] - this.column);
    this.column = segment[0];
  }
  mapped(column, source, line, sourceColumn, name = -1) {
    if (this.hasSegment && name < 0 && source === this.source && line === this.sourceLine && column - this.column === 1 && sourceColumn - this.sourceColumn === 1) {
      this.identityStep();
      this.column = column;
      this.sourceColumn = sourceColumn;
      this.segmentCount++;
      return;
    }
    if (this.hasSegment)
      this.write(44);
    this.hasSegment = true;
    this.segmentCount++;
    this.integer(column - this.column);
    this.integer(source - this.source);
    this.integer(line - this.sourceLine);
    this.integer(sourceColumn - this.sourceColumn);
    this.column = column;
    this.source = source;
    this.sourceLine = line;
    this.sourceColumn = sourceColumn;
    if (name < 0)
      return;
    this.integer(name - this.name);
    this.name = name;
  }
  identityStep() {
    if (this.position + 5 > this.buffer.length) {
      for (const value of [44, 67, 65, 65, 67])
        this.write(value);
      return;
    }
    const start = this.position;
    this.buffer[start] = 44;
    this.buffer[start + 1] = 67;
    this.buffer[start + 2] = 65;
    this.buffer[start + 3] = 65;
    this.buffer[start + 4] = 67;
    this.position += 5;
    if (this.position !== this.buffer.length)
      return;
    this.output += this.decoder.decode(this.buffer);
    this.position = 0;
  }
  finish() {
    return this.position > 0 ? this.output + this.decoder.decode(this.buffer.subarray(0, this.position)) : this.output;
  }
}

"#;

const GENERATE_MAP: &str = r#"	generateMap(options) {
		const generateDecodedMap = this.generateDecodedMap;
		if (generateDecodedMap !== defaultGenerateDecodedMap) return new SourceMap(generateDecodedMap.call(this, options));
		const properties = generateEncodedMap(this, options);
		const encoded = properties.mappings;
		properties.mappings = [];
		const map = new SourceMap(properties);
		map.mappings = encoded;
		return map;
	}
"#;

const SUFFIX: &str = r#"
const defaultGenerateDecodedMap = MagicString.prototype.generateDecodedMap;
class EncodedMappings extends Mappings {
  constructor(hires) {
    super(hires);
    this.raw = new EncodedLines;
    this.rawSegments = this.raw.startLine(0);
  }
  startLine() {
    return this.raw.startLine(this.generatedCodeLine);
  }
  addUneditedChunk(sourceIndex, chunk, original, loc, sourcemapLocations) {
    if (this.hires !== true)
      return super.addUneditedChunk(sourceIndex, chunk, original, loc, sourcemapLocations);
    for (let index = chunk.start;index < chunk.end; index++) {
      if (original[index] === `
`) {
        loc.line++;
        loc.column = 0;
        this.generatedCodeLine++;
        this.rawSegments = this.startLine();
        this.generatedCodeColumn = 0;
        continue;
      }
      this.raw.mapped(this.generatedCodeColumn, sourceIndex, loc.line, loc.column);
      loc.column++;
      this.generatedCodeColumn++;
    }
    this.pending = null;
  }
}

	function generateEncodedMap(string, options) {
		options = options || {};

		const sourceIndex = 0;
		const names = Object.keys(string.storedNames);
		const mappings = new EncodedMappings(options.hires);

		const locate = getLocator(string.original);

		if (string.intro) {
			mappings.advance(string.intro);
		}

		string.firstChunk.eachNext((chunk) => {
			const loc = locate(chunk.start);

			if (chunk.intro.length) mappings.advance(chunk.intro);

			if (chunk.edited) {
				mappings.addEdit(
					sourceIndex,
					chunk.content,
					loc,
					chunk.storeName ? names.indexOf(chunk.original) : -1,
				);
			} else {
				mappings.addUneditedChunk(sourceIndex, chunk, string.original, loc, string.sourcemapLocations);
			}

			if (chunk.outro.length) mappings.advance(chunk.outro);
		});

		if (string.outro) {
			mappings.advance(string.outro);
		}

		return {
			file: options.file ? options.file.split(/[/\\]/).pop() : undefined,
			sources: [
				options.source ? getRelativePath(options.file || '', options.source) : options.file || '',
			],
			sourcesContent: options.includeContent ? [string.original] : undefined,
			names,
			mappings: mappings.raw.finish(),
			x_google_ignoreList: string.ignoreList ? [sourceIndex] : undefined,
		};
	}
"#;
