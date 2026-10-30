(function (internal: BunWasm.Internal) {
  "use strict";
  type Input = Pick<BunWasm.NodeReadable, "on" | "removeListener" | "pause" | "resume">;
  type Output = { write(text: string): unknown };
  type Options = { input: Input; output?: Output; prompt?: string };
  type Answer = (line: string) => void;
  type Callback = () => void;
  const EventEmitter = internal.require("events");

  class Interface extends EventEmitter {
    input: Input;
    output: Output | undefined;
    terminal = false;
    line = "";
    closed = false;
    _prompt: string;
    _pendingQuestion: Answer | null = null;
    _started = false;
    _attached = false;
    _paused = false;
    _buffered = "";
    _decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    _onData = (chunk: unknown) => this._consume(chunk instanceof Uint8Array
      ? this._decoder.decode(chunk, { stream: true }) : this._decoder.decode() + String(chunk));
    _onEnd = () => {
      this._consume(this._decoder.decode());
      if (this._buffered && !this.closed) this._deliver(this._buffered);
      this._buffered = "";
      this.close();
    };

    constructor(input: Input | Options, output?: Output) {
      super();
      const opts = "input" in input ? input : { input, output };
      this.input = opts.input;
      this.output = opts.output;
      this._prompt = opts.prompt === undefined ? "> " : opts.prompt;
      this.on("newListener", event => {
        if (event === "line") this._start();
      });
    }
    _start() {
      if (this._started || this.closed) return;
      this._started = true;
      internal.realTimers.setImmediate(() => this._pump());
    }
    _pump() {
      if (this.closed) return;
      this._attached = true;
      this.input.on("data", this._onData);
      this.input.on("end", this._onEnd);
      if (this._paused) this.input.pause();
      else this.input.resume();
    }
    _consume(chunk: string) {
      this._buffered += chunk;
      const parts = this._buffered.split(/\r?\n/);
      this._buffered = parts.pop() ?? "";
      for (const line of parts) {
        if (this.closed) return;
        this._deliver(line);
      }
    }
    _deliver(line: string) {
      if (this._pendingQuestion) {
        const callback = this._pendingQuestion;
        this._pendingQuestion = null;
        callback(line);
        return;
      }
      this.emit("line", line);
    }
    question(query: string, options: unknown, callback?: Answer) {
      if (this.closed) return;
      if (typeof options === "function") callback = line => options(line);
      if (!callback) throw new TypeError("The callback argument must be a function");
      if (this._pendingQuestion) { this.resume(); return; }
      this._pendingQuestion = callback;
      this.output?.write(query);
      this.resume();
    }
    prompt() {
      this.output?.write(this._prompt);
      this.resume();
    }
    setPrompt(prompt: string) { this._prompt = prompt; }
    getPrompt() { return this._prompt; }
    write(data: string) { this.output?.write(data); }
    pause() { this._paused = true; this.input.pause(); return this; }
    resume() {
      if (this.closed) return this;
      this._paused = false;
      this._start();
      if (this._attached) this.input.resume();
      return this;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.input.removeListener("data", this._onData);
      this.input.removeListener("end", this._onEnd);
      this.input.pause();
      this._pendingQuestion = null;
      this.emit("close");
    }
    async *[Symbol.asyncIterator]() {
      const lines: string[] = [];
      let done = this.closed;
      let wake: Callback | undefined;
      const onLine = (line: unknown) => { lines.push(String(line)); wake?.(); };
      const onClose = () => { done = true; wake?.(); };
      const nextLine = async () => {
        while (!done && !lines.length) await new Promise<void>(resolve => { wake = resolve; });
        return lines.shift();
      };
      this.on("line", onLine);
      this.on("close", onClose);
      try {
        for (let line = await nextLine(); line !== undefined; line = await nextLine()) yield line;
      } finally {
        this.removeListener("line", onLine);
        this.removeListener("close", onClose);
        this.close();
      }
    }
  }
  const createInterface = (input: Input | Options, output?: Output) => new Interface(input, output);
  const promises = {
    Interface,
    createInterface(input: Input | Options, output?: Output) {
      const rl = new Interface(input, output);
      const ask = rl.question.bind(rl);
      return Object.assign(rl, { question: (query: string) => new Promise<string>(resolve => ask(query, resolve)) });
    },
  };
  return {
    Interface,
    createInterface,
    promises,
    clearLine: (_stream: unknown, _direction: number, callback?: Callback) => { callback?.(); return true; },
    clearScreenDown: (_stream: unknown, callback?: Callback) => { callback?.(); return true; },
    cursorTo: (_stream: unknown, _x: number, y?: number | Callback, callback?: Callback) => {
      if (typeof y === "function") y();
      else callback?.();
      return true;
    },
    moveCursor: (_stream: unknown, _dx: number, _dy: number, callback?: Callback) => { callback?.(); return true; },
    emitKeypressEvents() {},
  };
})
