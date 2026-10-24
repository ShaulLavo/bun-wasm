interface SymbolConstructor { readonly dispose: unique symbol }
declare namespace BunWasm {
  type SQLiteDatabaseHandle = number & { readonly __sqliteDatabase: unique symbol };
  type SQLiteStatementHandle = number & { readonly __sqliteStatement: unique symbol };
  type SQLiteBinding = null | boolean | number | bigint | string | Uint8Array;
  type SQLiteInteger<Safe extends boolean> = Safe extends true ? bigint : number;
  type SQLiteValue<Safe extends boolean = boolean> = null | number | SQLiteInteger<Safe> | string | Uint8Array;
  type SQLiteRow<Safe extends boolean = boolean> = Record<string, SQLiteValue<Safe> | undefined>;
  type SQLiteColumnType = "INTEGER" | "FLOAT" | "TEXT" | "BLOB" | "NULL";
  type SQLiteChanges<Safe extends boolean> = [changes: number, lastInsertRowid: SQLiteInteger<Safe>];
  type SQLiteRows<Safe extends boolean> = [SQLiteRow<Safe> | null, SQLiteRow<Safe>[], SQLiteValue<Safe>[][] | null, (Uint8Array | null)[][] | null];
  interface SQLiteNative {
    open(path: string, flags: number): SQLiteDatabaseHandle;
    deserialize(bytes: ArrayBufferView, readonly: boolean): SQLiteDatabaseHandle;
    serialize(handle: SQLiteDatabaseHandle, schema: string): Uint8Array;
    close(handle: SQLiteDatabaseHandle, force: boolean): void;
    inTransaction(handle: SQLiteDatabaseHandle): boolean;
    firstParamNames(handle: SQLiteDatabaseHandle, query: string): (string | null)[] | null;
    exec<Safe extends boolean>(handle: SQLiteDatabaseHandle, query: string, values: readonly SQLiteBinding[] | null, safe: Safe): SQLiteChanges<Safe>;
    prepare(handle: SQLiteDatabaseHandle, query: string, flags: number, owned: boolean): SQLiteStatementHandle;
    rows<Mode extends 0 | 1 | 2 | 3, Safe extends boolean>(handle: SQLiteStatementHandle, values: readonly SQLiteBinding[] | undefined, mode: Mode, safe: Safe): SQLiteRows<Safe>[Mode];
    next<Safe extends boolean>(handle: SQLiteStatementHandle, values: readonly SQLiteBinding[] | undefined, first: boolean, safe: Safe): SQLiteRow<Safe> | null;
    run<Safe extends boolean>(handle: SQLiteStatementHandle, values: readonly SQLiteBinding[] | undefined, safe: Safe): SQLiteChanges<Safe>;
    bind(handle: SQLiteStatementHandle, values: readonly SQLiteBinding[]): void;
    paramNames(handle: SQLiteStatementHandle): (string | null)[];
    columns(handle: SQLiteStatementHandle): string[];
    columnTypes(handle: SQLiteStatementHandle): SQLiteColumnType[];
    declaredTypes(handle: SQLiteStatementHandle): (string | null)[];
    paramsCount(handle: SQLiteStatementHandle): number;
    expandedSql(handle: SQLiteStatementHandle): string;
    isFinalized(handle: SQLiteStatementHandle): boolean;
    finalize(handle: SQLiteStatementHandle): void;
    release(handle: SQLiteStatementHandle): void;
  }
  interface Native { sqlite: SQLiteNative }
}
