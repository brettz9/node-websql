export default WebSQLResultSet;
declare function WebSQLResultSet(insertId: any, rowsAffected: any, rows: any): void;
declare class WebSQLResultSet {
    constructor(insertId: any, rowsAffected: any, rows: any);
    insertId: any;
    rowsAffected: any;
    rows: WebSQLRows;
}
declare function WebSQLRows(array: any): void;
declare class WebSQLRows {
    constructor(array: any);
    _array: any;
    length: any;
    item(i: any): any;
}
//# sourceMappingURL=WebSQLResultSet.d.ts.map