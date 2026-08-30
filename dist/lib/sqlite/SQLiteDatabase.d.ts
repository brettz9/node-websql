export default SQLiteDatabase;
export type SQLiteDatabaseOptions = {
    busyTimeout?: number | undefined;
    trace?: ((sql: string) => void) | undefined;
    profile?: ((sql: string, time: number) => void) | undefined;
    memoryQuota?: number | undefined;
};
/**
 * A swappable SQLite driver for `websql-configurable`, backed by the
 * synchronous `better-sqlite3` bindings. Implements the same
 * constructor/`exec()` contract described in the README's "Custom SQLite3
 * bindings" section, plus node-sqlite3's `configure()`/`close()` for
 * drop-in compatibility.
 */
declare class SQLiteDatabase {
    /**
     * @param {string} name
     * @param {SQLiteDatabaseOptions} [opts]
     */
    constructor(name: string, opts?: SQLiteDatabaseOptions);
    _qFilePath: string;
    /** @type {any} */
    _db: any;
    /** @type {((sql: string) => void) | undefined} */
    _trace: ((sql: string) => void) | undefined;
    /** @type {((sql: string, time: number) => void) | undefined} */
    _profile: ((sql: string, time: number) => void) | undefined;
    /**
     * Compatibility with node-sqlite3's `configure()` API.
     * @param {'busyTimeout'|'trace'|'profile'|'memoryQuota'} option
     * @param {number|((sql: string, time?: number) => void)} value
     * @returns {void}
     */
    configure(option: "busyTimeout" | "trace" | "profile" | "memoryQuota", value: number | ((sql: string, time?: number) => void)): void;
    /**
     * Compatibility with callback-oriented close semantics.
     * @param {(err?: Error | null) => void} [cb]
     * @returns {void}
     */
    close(cb?: (err?: Error | null) => void): void;
    /**
     * @param {import('../types.js').SqlQuery[]} queries
     * @param {boolean} readOnly
     * @param {(err: Error | null, results?: SQLiteResult[]) => void} callback
     * @returns {void}
     */
    exec(queries: import("../types.js").SqlQuery[], readOnly: boolean, callback: (err: Error | null, results?: SQLiteResult[]) => void): void;
    #private;
}
import SQLiteResult from './SQLiteResult.js';
//# sourceMappingURL=SQLiteDatabase.d.ts.map