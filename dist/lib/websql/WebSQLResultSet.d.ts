export default WebSQLResultSet;
/**
 *
 */
declare class WebSQLResultSet {
    /**
     * @param {number} [insertId]
     * @param {number} [rowsAffected]
     * @param {unknown[]} [rows]
     */
    constructor(insertId?: number, rowsAffected?: number, rows?: unknown[]);
    insertId: number | undefined;
    rowsAffected: number | undefined;
    rows: WebSQLRows;
}
/**
 *
 */
declare class WebSQLRows {
    /**
     * @param {unknown[]} array
     */
    constructor(array: unknown[]);
    _array: unknown[];
    length: number;
    /**
     * @param {number} i
     */
    item(i: number): unknown;
}
//# sourceMappingURL=WebSQLResultSet.d.ts.map