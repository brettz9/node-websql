export = SQLiteDatabase;
declare function SQLiteDatabase(name: any, opts: any): void;
declare class SQLiteDatabase {
    constructor(name: any, opts: any);
    _db: sqlite3.Database;
    exec(queries: any, readOnly: any, callback: any): void;
}
import sqlite3 = require("sqlite3");
//# sourceMappingURL=SQLiteDatabase.d.ts.map