import noop from 'noop-fn';
import Queue from 'tiny-queue';
import immediate from 'immediate';
import WebSQLResultSet from './WebSQLResultSet.js';

/**
 * These deliberately don't reuse the WebSQL spec's global
 * `SQLStatementCallback`/`SQLStatementErrorCallback`/`SQLError` types:
 * this library never constructs a real `SQLError` (errors here are
 * always plain `Error`s coming from the underlying SQL driver), and
 * `WebSQLResultSet#insertId`/`rowsAffected` are genuinely `number |
 * undefined` (see `massageSQLResult` below), which the spec's
 * `SQLResultSet` doesn't allow. Typing against the spec here would just
 * paper over that mismatch with unsound casts.
 * @typedef {(transaction: WebSQLTransaction, resultSet: WebSQLResultSet) => void} SqlCallback
 * @typedef {(transaction: WebSQLTransaction, error: Error) => boolean | void} SqlErrorCallback
 */

function errorUnhandled() {
  return true; // a non-truthy return indicates error was handled
}

// WebSQL has some bizarre behavior regarding insertId/rowsAffected. To try
// to match the observed behavior of Chrome/Safari as much as possible, we
// sniff the SQL message to try to massage the returned insertId/rowsAffected.
// This helps us pass the tests, although it's error-prone and should
// probably be revised.
/**
 * @param {string} sql
 * @param {number} [insertId]
 * @param {number} [rowsAffected]
 * @param {unknown[]} [rows]
 */
function massageSQLResult(sql, insertId, rowsAffected, rows) {
  if (/^\s*UPDATE\b/i.test(sql)) {
    // insertId is always undefined for "UPDATE" statements
    insertId = void 0;
  } else if (/^\s*CREATE\s+TABLE\b/i.test(sql)) {
    // WebSQL always returns an insertId of 0 for "CREATE TABLE" statements
    insertId = 0;
    rowsAffected = 0;
  } else if (/^\s*DROP\s+TABLE\b/i.test(sql)) {
    // WebSQL always returns insertId=undefined and rowsAffected=0
    // for "DROP TABLE" statements. Go figure.
    insertId = void 0;
    rowsAffected = 0;
  } else if (!/^\s*INSERT\b/i.test(sql)) {
    // for all non-inserts (deletes, etc.) insertId is always undefined
    // ¯\_(ツ)_/¯
    insertId = void 0;
  }
  return new WebSQLResultSet(insertId, rowsAffected, rows);
}

class SQLTask {
  /**
   * @param {string} sql
   * @param {ObjectArray} args
   * @param {SqlCallback} sqlCallback
   * @param {SqlErrorCallback} sqlErrorCallback
   */
  constructor(sql, args, sqlCallback, sqlErrorCallback) {
    this.sql = sql;
    this.args = args;
    this.sqlCallback = sqlCallback;
    this.sqlErrorCallback = sqlErrorCallback;
  }
}

/**
 * @param {WebSQLTransaction} self
 * @param {SQLTask[]} batch
 */
function runBatch(self, batch) {

  function onDone() {
    self._running = false;
    runAllSql(self);
  }

  var currentTask = /** @type {import('./WebSQLDatabase.js').TransactionTask} */ (
    self._websqlDatabase._currentTask);
  var readOnly = currentTask.readOnly;

  self._websqlDatabase._db.exec(batch, readOnly, function (err, results) {
    /* c8 ignore next */
    if (err || !results) {
      self._error = err || new Error('exec() did not return results');
      return onDone();
    }
    for (var i = 0; i < results.length; i++) {
      var res = results[i];
      var batchTask = batch[i];
      if (res.error) {
        if (batchTask.sqlErrorCallback(self, res.error)) {
          // user didn't handle the error
          self._error = res.error;
          return onDone();
        }
      } else {
        try {
          batchTask.sqlCallback(self, massageSQLResult(
            batch[i].sql, res.insertId, res.rowsAffected, res.rows));
        } catch (err) {
          self._error = /** @type {Error} */ (err);
          runAllSql(self);
        }
      }
    }
    onDone();
  });
}

/**
 * @param {WebSQLTransaction} self
 */
function runAllSql(self) {
  if (self._running || self._complete) {
    return;
  }
  if (self._error) {
    self._complete = true;
    return self._websqlDatabase._onTransactionComplete(self._error, self);
  }
  if (!self._sqlQueue.length) {
    // Do not mark `_complete` here: the caller (via `nonstandardTransCb`,
    // see `WebSQLDatabase#_onTransactionComplete`) may choose to defer the
    // actual commit/rollback decision, in which case more SQL might still
    // be queued via `executeSql()` later and must still be able to run.
    // `_complete` is only set once that decision is actually final (see
    // `_onTransactionComplete`'s `done`).
    return self._websqlDatabase._onTransactionComplete(self._error, self);
  }
  self._running = true;
  /** @type {SQLTask[]} */
  var batch = [];
  var task;
  while ((task = self._sqlQueue.shift())) {
    batch.push(task);
  }
  runBatch(self, batch);
}

/**
 * @param {WebSQLTransaction} self
 * @param {string} sql
 * @param {ObjectArray} args
 * @param {SqlCallback} sqlCallback
 * @param {SqlErrorCallback} sqlErrorCallback
 * @param {import('../types.js').Delay} executeDelay
 */
function executeSql(self, sql, args, sqlCallback, sqlErrorCallback, executeDelay) {
  self._sqlQueue.push(new SQLTask(sql, args, sqlCallback, sqlErrorCallback));
  if (self._runningTimeout) {
    return;
  }
  self._runningTimeout = true;
  executeDelay(function () {
    self._runningTimeout = false;
    runAllSql(self);
  });
}

class WebSQLTransaction {
  /**
   * @param {import('./WebSQLDatabase.js').default} websqlDatabase
   * @param {import('../types.js').Delay} [executeDelay]
   */
  constructor(websqlDatabase, executeDelay) {
    this._websqlDatabase = websqlDatabase;
    /** @type {Error | null} */
    this._error = null;
    this._complete = false;
    this._running = false;
    this._runningTimeout = false;
    this._executeDelay = executeDelay || immediate;
    /** @type {import('tiny-queue').default<SQLTask>} */
    this._sqlQueue = new Queue();
    var currentTask = /** @type {import('./WebSQLDatabase.js').TransactionTask} */ (
      websqlDatabase._currentTask);
    if (!currentTask.readOnly) {
      // Since we serialize all access to the database, there is no need to
      // run read-only tasks in a transaction. This is a perf boost.
      this._sqlQueue.push(new SQLTask('BEGIN;', [], noop, noop));
    }
  }

  /**
   * @param {string} sql
   * @param {ObjectArray} args
   * @param {SqlCallback} sqlCallback
   * @param {SqlErrorCallback} sqlErrorCallback
   */
  executeSql(sql, args, sqlCallback, sqlErrorCallback) {
    args = Array.isArray(args) ? args : [];
    sqlCallback = typeof sqlCallback === 'function' ? sqlCallback : noop;
    sqlErrorCallback = typeof sqlErrorCallback === 'function' ? sqlErrorCallback : errorUnhandled;

    executeSql(this, sql, args, sqlCallback, sqlErrorCallback, this._executeDelay);
  }

  _checkDone() {
    runAllSql(this);
  }
}

export default WebSQLTransaction;
