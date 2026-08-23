export default customOpenDatabase;
/**
 * @template Opts
 * @param {import('./types.js').SqlDriverConstructor<Opts>} SQLiteDatabase
 * @param {{ sqlite?: Opts, websql?: import('./types.js').WebSQLOverrides }} [opts]
 */
declare function customOpenDatabase<Opts>(SQLiteDatabase: import("./types.js").SqlDriverConstructor<Opts>, opts?: {
    sqlite?: Opts;
    websql?: import("./types.js").WebSQLOverrides;
}): (/** @type {unknown[]} */ ...args: unknown[]) => WebSQLDatabase;
import WebSQLDatabase from './websql/WebSQLDatabase.js';
//# sourceMappingURL=custom.d.ts.map