/** A single SQL statement plus its bound arguments, as queued for execution. */
export interface SqlQuery {
  sql: string;
  args: ObjectArray;
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
}
