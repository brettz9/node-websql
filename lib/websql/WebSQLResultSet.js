class WebSQLRows {
  /**
   * @param {unknown[]} array
   */
  constructor(array) {
    this._array = array;
    this.length = array.length;
  }

  /**
   * @param {number} i
   */
  item(i) {
    return this._array[i];
  }
}

class WebSQLResultSet {
  /**
   * @param {number} [insertId]
   * @param {number} [rowsAffected]
   * @param {unknown[]} [rows]
   */
  constructor(insertId, rowsAffected, rows) {
    this.insertId = insertId;
    this.rowsAffected = rowsAffected;
    this.rows = new WebSQLRows(rows || []);
  }
}

export default WebSQLResultSet;
