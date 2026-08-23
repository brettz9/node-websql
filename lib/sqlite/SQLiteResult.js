/**
 *
 */
class SQLiteResult {
  /**
   * @param {Error | null} error
   * @param {number} [insertId]
   * @param {number} [rowsAffected]
   * @param {unknown[]} [rows]
   */
  constructor (error, insertId, rowsAffected, rows) {
    this.error = error;
    this.insertId = insertId;
    this.rowsAffected = rowsAffected;
    this.rows = rows;
  }
}

export default SQLiteResult;
