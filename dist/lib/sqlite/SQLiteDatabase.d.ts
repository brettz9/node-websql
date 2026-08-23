export default SQLiteDatabase;
export type SQLiteDatabaseOptions = {
    busyTimeout?: number | undefined;
    trace?: ((sql: string) => void) | undefined;
    profile?: ((sql: string, time: number) => void) | undefined;
};
/**
 *
 */
declare class SQLiteDatabase {
    /**
     * @param {string} name
     * @param {SQLiteDatabaseOptions} [opts]
     */
    constructor(name: string, opts?: SQLiteDatabaseOptions);
    _db: sqlite3.Database;
    /**
     * @param {import('../types.js').SqlQuery[]} queries
     * @param {boolean} readOnly
     * @param {(err: Error | null, results?: SQLiteResult[]) => void} callback
     */
    exec(queries: import("../types.js").SqlQuery[], readOnly: boolean, callback: (err: Error | null, results?: SQLiteResult[]) => void): void;
}
import sqlite3 from 'sqlite3';
import SQLiteResult from './SQLiteResult.js';
//# sourceMappingURL=SQLiteDatabase.d.ts.map