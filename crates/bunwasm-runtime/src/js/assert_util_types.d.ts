declare namespace BunWasm {
  interface UtilityError extends Error { code?: string; reason?: unknown }
  interface InspectOptions {
    showHidden?: boolean; depth?: number | null; colors?: boolean; customInspect?: boolean;
    showProxy?: boolean; maxArrayLength?: number | null; maxStringLength?: number | null;
    breakLength?: number; compact?: boolean | number; sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | "get" | "set"; numericSeparator?: boolean;
  }
  interface InspectFunction {
    (value: unknown, options?: InspectOptions): string;
    defaultOptions?: InspectOptions;
    colors?: Record<string, number[]>;
    styles?: Record<string, string>;
  }
  interface AssertionOptions {
    actual?: unknown; expected?: unknown; message?: unknown; operator: string; stackStartFn?: Function;
  }
  type AssertionDiff = [operation: "nop" | "insert" | "delete", line: string];
  interface UtilityModule {
    parseArgs(config?: unknown): ParseArgsResult;
    bunDeepEquals(a: unknown, b: unknown, strict?: boolean): boolean;
    isDeepStrictEqual(a: unknown, b: unknown): boolean;
    types: { isRegExp(value: unknown): value is RegExp; isNativeError(value: unknown): value is Error };
  }
  interface ConsoleInspector {
    nodeInspect: InspectFunction;
    nodeFormat: { (...args: unknown[]): string; apply(receiver: unknown, args: IArguments): string };
    nodeFormatWithOptions: { (options: InspectOptions, ...args: unknown[]): string; apply(receiver: unknown, args: IArguments): string };
  }
  interface Internal {
    require(name: "util"): UtilityModule;
    require(name: "inspect"): ConsoleInspector;
    require(name: "partial_assert"): {
      create(fail: (options: AssertionOptions) => never, requireArgs: (count: number, min: number) => void): (actual: unknown, expected: unknown, message?: unknown) => void;
    };
  }
}
interface ErrorConstructor {
  captureStackTrace(target: object, constructor?: Function): void;
  isError?(value: unknown): value is Error;
}

declare namespace BunWasm {
  interface UtilityFunction {
    (this: unknown, ...args: unknown[]): unknown;
    prototype?: unknown;
    [key: symbol]: unknown;
  }
  interface EqualityMemo { val1: Map<object, number>; val2: Map<object, number>; position: number }
  interface ComparisonError extends Error { errors?: unknown }
  type BoxedPrimitive<Value> = object & { valueOf(): Value };
  interface NumericView extends ArrayBufferView, ArrayLike<number | bigint> {}
  interface OptionToken {
    kind: "option"; name: unknown; rawName: unknown; index: number;
    value: unknown; inlineValue: boolean | undefined;
  }
  type ParseToken = OptionToken | { kind: "positional"; index: number; value: unknown } | { kind: "option-terminator"; index: number };
  interface ParseArgsResult { values: Record<PropertyKey, unknown>; positionals: unknown[]; tokens?: ParseToken[] }
  interface BufferConstructor { isBuffer(value: unknown): boolean }
  interface Internal {
    isPromise?(value: unknown): value is Promise<unknown>;
    isError?(value: unknown): value is Error;
    isModuleNamespaceObject?(value: unknown): boolean;
    crypto: { isKey(value: unknown): boolean };
    nodeCryptoIsKeyObject(value: unknown): boolean;
    builtin(name: "node:crypto"): unknown;
  }
}
interface String { toWellFormed?(): string }
declare const Float16Array: Function;
