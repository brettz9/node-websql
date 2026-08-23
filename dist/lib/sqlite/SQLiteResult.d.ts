export default SQLiteResult;
/**
 *
 */
declare class SQLiteResult {
    /**
     * @param {Error | null} error
     * @param {number} [insertId]
     * @param {number} [rowsAffected]
     * @param {unknown[]} [rows]
     */
    constructor(error: Error | null, insertId?: number, rowsAffected?: number, rows?: unknown[]);
    error: Error | null;
    insertId: number | undefined;
    rowsAffected: number | undefined;
    rows: unknown[] | undefined;
}
//# sourceMappingURL=SQLiteResult.d.ts.map