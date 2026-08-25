export default WebSQLTransaction;
/**
 * These deliberately don't reuse the WebSQL spec's global
 * `SQLStatementCallback`/`SQLStatementErrorCallback`/`SQLError` types:
 * this library never constructs a real `SQLError` (errors here are
 * always plain `Error`s coming from the underlying SQL driver), and
 * `WebSQLResultSet#insertId`/`rowsAffected` are genuinely `number |
 * undefined` (see `massageSQLResult` below), which the spec's
 * `SQLResultSet` doesn't allow. Typing against the spec here would just
 * paper over that mismatch with unsound casts.
 */
export type SqlCallback = (transaction: WebSQLTransaction, resultSet: WebSQLResultSet) => void;
/**
 * These deliberately don't reuse the WebSQL spec's global
 * `SQLStatementCallback`/`SQLStatementErrorCallback`/`SQLError` types:
 * this library never constructs a real `SQLError` (errors here are
 * always plain `Error`s coming from the underlying SQL driver), and
 * `WebSQLResultSet#insertId`/`rowsAffected` are genuinely `number |
 * undefined` (see `massageSQLResult` below), which the spec's
 * `SQLResultSet` doesn't allow. Typing against the spec here would just
 * paper over that mismatch with unsound casts.
 */
export type SqlErrorCallback = (transaction: WebSQLTransaction, error: Error) => boolean | void;
/**
 *
 */
declare class WebSQLTransaction {
    /**
     * @param {import('./WebSQLDatabase.js').default} websqlDatabase
     * @param {import('./WebSQLDatabase.js').TransactionTask} task
     * @param {import('../types.js').Delay} [executeDelay]
     */
    constructor(websqlDatabase: import("./WebSQLDatabase.js").default, task: import("./WebSQLDatabase.js").TransactionTask, executeDelay?: import("../types.js").Delay);
    _websqlDatabase: import("./WebSQLDatabase.js").default;
    _task: import("./WebSQLDatabase.js").TransactionTask;
    /** @type {Error | null} */
    _error: Error | null;
    _complete: boolean;
    _running: boolean;
    _runningTimeout: boolean;
    _executeDelay: typeof immediate | import("../types.js").Delay;
    /** @type {import('tiny-queue').default<SQLTask>} */
    _sqlQueue: import("tiny-queue").default<SQLTask>;
    /**
     * @param {string} sql
     * @param {unknown[]} [args]
     * @param {SqlCallback} [sqlCallback]
     * @param {SqlErrorCallback} [sqlErrorCallback]
     */
    executeSql(sql: string, args?: unknown[], sqlCallback?: SqlCallback, sqlErrorCallback?: SqlErrorCallback): void;
    /**
     * Not a true `#private` method: `WebSQLDatabase` calls this right after
     * handing a freshly-created transaction to the caller's `txnCallback`.
     */
    _checkDone(): void;
}
import WebSQLResultSet from './WebSQLResultSet.js';
import immediate from 'immediate';
/**
 *
 */
declare class SQLTask {
    /**
     * @param {string} sql
     * @param {unknown[]} args
     * @param {SqlCallback} sqlCallback
     * @param {SqlErrorCallback} sqlErrorCallback
     */
    constructor(sql: string, args: unknown[], sqlCallback: SqlCallback, sqlErrorCallback: SqlErrorCallback);
    sql: string;
    args: unknown[];
    sqlCallback: SqlCallback;
    sqlErrorCallback: SqlErrorCallback;
}
//# sourceMappingURL=WebSQLTransaction.d.ts.map