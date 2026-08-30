// This file is what every emitted public `.d.ts` (in dist/) type-only
// imports via `import('../types.js')`, so it's also the anchor that pulls
// `ambient.d.ts` into a *consumer's* program -- ambient `.d.ts` files
// aren't picked up from a dependency's folder automatically otherwise.
/// <reference path="./ambient.d.ts" />

/** A single SQL statement plus its bound arguments, as queued for execution. */
export interface SqlQuery {
  sql: string;
  args: unknown[];
}

/** The result of running one {@link SqlQuery}. */
export interface SqlExecResult {
  error?: Error | null;
  insertId?: number;
  rowsAffected?: number;
  rows?: unknown[];
}

/**
 * The interface a custom SQLite3 driver must implement (see README's
 * "Custom SQLite3 bindings" section).
 */
export interface SqlDriver {
  exec(
    queries: SqlQuery[],
    readOnly: boolean,
    callback: (err: Error | null, results?: SqlExecResult[]) => void
  ): void;
}

/** A constructor for a {@link SqlDriver}, e.g. `SQLiteDatabase`. */
export interface SqlDriverConstructor<Opts> {
  new (name: string, opts?: Opts): SqlDriver;
}

/** A task scheduler such as `immediate`, used to defer work by a tick. */
export type Delay = (task: () => void) => void;

export interface WebSQLOverrides {
  openDelay?: Delay;
  transactionDelay?: Delay;
  executeDelay?: Delay;
  /**
   * Off by default, preserving the WebSQL spec's guarantee that queued
   * transactions -- read or write alike -- run strictly one at a time, in
   * the order requested (`WebSQLDatabase`'s own test suite depends on
   * this). When explicitly enabled, any number of `readTransaction()`s
   * may instead run concurrently (SQLite itself supports concurrent
   * reads, and reads don't need atomicity against each other); a
   * `transaction()` (read-write) still always runs with full exclusivity.
   * Only meaningful for a consumer -- like IndexedDBShim -- that uses this
   * library purely as an internal SQL execution engine and doesn't need
   * (or expose) WebSQL's own strict-ordering guarantee itself.
   */
  concurrentReaders?: boolean;
}
