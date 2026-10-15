const PREFIX = "[bunwasm:startup] ";

/** Keep ordinary stdout streaming; only hold a possible startup record until its newline. */
export class StartupOutput {
  private decoder = new TextDecoder();
  private pending = "";
  private lineStart = true;

  constructor(private writeText: (text: string) => void, private phase: (line: string) => boolean) {}

  write(data: Uint8Array): void {
    this.pending += this.decoder.decode(data, { stream: true });
    while (this.pending) {
      if (this.lineStart && PREFIX.startsWith(this.pending)) return;
      if (this.lineStart && this.pending.startsWith(PREFIX)) {
        if (!this.record()) return;
        continue;
      }
      this.text();
    }
  }

  private record(): boolean {
    const end = this.pending.indexOf("\n");
    if (end < 0) return false;
    const line = this.pending.slice(0, end);
    if (!this.phase(line.slice(PREFIX.length))) this.writeText(`${line}\n`);
    this.pending = this.pending.slice(end + 1);
    return true;
  }

  private text(): void {
    const end = this.pending.indexOf("\n");
    const length = end < 0 ? this.pending.length : end + 1;
    this.writeText(this.pending.slice(0, length));
    this.pending = this.pending.slice(length);
    this.lineStart = end >= 0;
  }

  flush(): void {
    this.writeText(this.pending + this.decoder.decode());
    this.pending = "";
  }
}
