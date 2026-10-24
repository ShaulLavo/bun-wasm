declare namespace BunWasm {
  type ConsoleFunction = (...args: never[]) => unknown;
  interface ConsoleTrace { name: string; message?: string; stack?: unknown }
  interface ConsoleInspectOptions {
    depth?: number; compact?: boolean; colors?: boolean; sorted?: boolean;
    showHidden?: boolean; getters?: boolean; customInspect?: boolean;
  }
  interface ConsoleInspector {
    nodeInspect(value: unknown, options?: ConsoleInspectOptions): string;
    formatArgs(args: readonly unknown[], options?: ConsoleInspectOptions): string;
    bunInspect(value: unknown, options?: ConsoleInspectOptions): string;
  }
  interface ConsoleBuiltins {
    "node:util": {
      inspect(value: unknown, options?: ConsoleInspectOptions): string;
      formatWithOptions(options: ConsoleInspectOptions, ...args: unknown[]): string;
    };
    "node:buffer": { isBuffer(value: unknown): boolean };
    "node:util/types": { isMapIterator(value: unknown): boolean; isSetIterator(value: unknown): boolean };
  }
  interface ConsoleValidators {
    validateObject(value: unknown, name: string): void;
    validateInteger(value: unknown, name: string, min: number, max: number): void;
    validateArray(value: unknown, name: string): void;
    validateOneOf(value: unknown, name: string, choices: readonly unknown[]): void;
  }
  interface ConsoleIntrinsics {
    require(name: "internal/validators"): ConsoleValidators;
    require<K extends keyof ConsoleBuiltins>(name: K): ConsoleBuiltins[K];
    captureStackTrace(target: ConsoleTrace, skip?: ConsoleFunction): void;
    call<This, Args extends unknown[], Result>(fn: (this: This, ...args: Args) => Result, receiver: This, ...args: Args): Result;
    apply<This, Args extends unknown[], Result>(fn: (this: This, ...args: Args) => Result, receiver: This, args: Args): Result;
    get<Key, Value>(map: Map<Key, Value>, key: Key): Value | undefined;
    isMap(value: unknown): boolean;
    isSet(value: unknown): boolean;
    isJSArray: typeof Array.isArray;
    isTypedArrayView: typeof ArrayBuffer.isView;
    newArrayWithSize<Value>(length: number): Value[];
    newCppFunction(file: string, name: string): (text: string, strip?: boolean) => number;
    ERR_CONSOLE_WRITABLE_STREAM(message: string): Error & { code: string };
    ERR_INCOMPATIBLE_OPTION_PAIR(message: string): Error & { code: string };
  }
  interface ConsoleConstructor {
    (stdout: WorkerWritable, stderr?: WorkerWritable, ignoreErrors?: boolean): object;
    new(stdout: WorkerWritable, stderr?: WorkerWritable, ignoreErrors?: boolean): object;
    new(options: { stdout: WorkerWritable; stderr?: WorkerWritable; ignoreErrors?: boolean; colorMode?: boolean | "auto"; inspectOptions?: ConsoleInspectOptions | Map<WorkerWritable, ConsoleInspectOptions>; groupIndentation?: number }): object;
  }
  interface Native {
    writeStdout(data: string | Uint8Array, flush?: boolean): void;
    writeStderr(data: string | Uint8Array): void;
    now(): number;
  }
  interface Internal {
    require(name: "inspect"): ConsoleInspector;
    require(name: "console_constructor"): ConsoleIntrinsics;
    require(name: "bun_console_constructor"): (console: object) => ConsoleConstructor;
    builtin<K extends keyof ConsoleBuiltins>(name: K): ConsoleBuiltins[K];
    readonly defaultPrepareStackTrace?: unknown;
  }
  interface ConsoleInternal extends Internal {
    toUint8(value: unknown): Uint8Array;
  }
}
